/**
 * Learn Energy - Charging Speed Learning System
 * Analyzes completed charging sessions to calibrate real-world charging speeds.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from '../_shared/auth.ts';
import { fetchWithTimeout } from '../_shared/model-registry.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface ChargingSession {
    id: string;
    connection_id: string;
    device_entity_id: string;
    battery_entity_id: string;
    start_time: string;
    duration_minutes: number;
    target_percent: number;
    status: string;
}

async function fetchHAHistory(
    apiUrl: string,
    token: string,
    entityId: string,
    startTime: Date,
    endTime: Date
): Promise<any[]> {
    const base = apiUrl.replace(/\/+$/, '');
    const url = `${base}/api/history/period/${encodeURIComponent(startTime.toISOString())}?filter_entity_id=${encodeURIComponent(entityId)}&end_time=${encodeURIComponent(endTime.toISOString())}`;

    const res = await fetchWithTimeout(url, {
        headers: { "Authorization": `Bearer ${token}` }
    }, 15000);

    if (!res.ok) return [];
    const data = await res.json();
    return data?.[0] || [];
}

function calculateChargingSpeed(
    historyPoints: any[],
    batteryCapacityKwh: number
): { speedKw: number; startPct: number; endPct: number } | null {
    if (historyPoints.length < 2) return null;

    const validPoints = historyPoints
        .filter(p => Number.isFinite(parseFloat(p.state)))
        .map(p => ({ pct: parseFloat(p.state), time: new Date(p.last_changed || p.last_updated) }))
        .filter(p => !isNaN(p.time.getTime()));

    if (validPoints.length < 2) return null;

    const startPct = validPoints[0].pct;
    const endPct = validPoints[validPoints.length - 1].pct;
    if (endPct <= startPct) return null;

    const pctGained = endPct - startPct;
    const kwhDelivered = (pctGained / 100) * batteryCapacityKwh;
    const actualDurationMs = validPoints[validPoints.length - 1].time.getTime() - validPoints[0].time.getTime();
    const actualDurationHours = actualDurationMs / (1000 * 60 * 60);

    if (actualDurationHours < 0.1) return null;

    const speedKw = kwhDelivered / actualDurationHours;
    if (speedKw < 1 || speedKw > 350) return null;

    return { speedKw, startPct, endPct };
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const results: any[] = [];

    try {
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) {
            return new Response(JSON.stringify({ error: auth.error }), {
                status: auth.status || 401,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        const raw = await req.text().catch(() => '');
        const body = raw.trim() ? JSON.parse(raw) : {};
        const requestedConnectionId: string | undefined = body.connection_id;

        let allowedConnIds: string[] | null = null;
        if (requestedConnectionId) {
            const ownership = await verifyConnectionOwnership(supabase, auth, requestedConnectionId);
            if (!ownership.valid) {
                return new Response(JSON.stringify({ error: ownership.error }), {
                    status: ownership.status || 403,
                    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
                });
            }
            allowedConnIds = [requestedConnectionId];
        } else if (!auth.isServiceOrCron && auth.userId) {
            const { data: userConns } = await supabase
                .from('ha_connections')
                .select('id')
                .eq('user_id', auth.userId);
            allowedConnIds = (userConns || []).map((c: any) => c.id);
            if (allowedConnIds.length === 0) {
                return new Response(JSON.stringify({ success: true, message: "Geen laadsessies gevonden.", learned: 0 }), {
                    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
                });
            }
        }

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // Only pick sessions that haven't already been processed (`status != 'learned'`) to prevent double-counting!
        let schedQuery = supabase
            .from('energy_schedules')
            .select('*')
            .gte('start_time', sevenDaysAgo)
            .neq('status', 'learned')
            .not('battery_entity_id', 'is', null)
            .not('target_percent', 'is', null);

        if (allowedConnIds) {
            schedQuery = schedQuery.in('connection_id', allowedConnIds);
        }

        const { data: schedules, error: schedError } = await schedQuery;
        if (schedError) throw schedError;

        if (!schedules || schedules.length === 0) {
            return new Response(JSON.stringify({
                success: true,
                message: "Geen nieuwe afgeronde laadsessies om te analyseren.",
                learned: 0
            }), {
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        const byConnection: Record<string, ChargingSession[]> = {};
        for (const s of schedules) {
            if (!byConnection[s.connection_id]) byConnection[s.connection_id] = [];
            byConnection[s.connection_id].push(s);
        }

        for (const [connectionId, sessions] of Object.entries(byConnection)) {
            const { data: conn } = await supabase
                .from('ha_connections')
                .select('api_url, api_token')
                .eq('id', connectionId)
                .single();

            if (!conn) continue;

            for (const session of sessions) {
                try {
                    const startTime = new Date(session.start_time);
                    const endTime = new Date(startTime.getTime() + session.duration_minutes * 60 * 1000);
                    if (endTime > new Date()) continue;

                    const history = await fetchHAHistory(
                        conn.api_url,
                        conn.api_token,
                        session.battery_entity_id,
                        startTime,
                        endTime
                    );

                    if (history.length === 0) {
                        await supabase.from('energy_schedules').update({ status: 'learned' }).eq('id', session.id);
                        continue;
                    }

                    const { data: currentParams } = await supabase
                        .from('charging_params')
                        .select('*')
                        .eq('connection_id', connectionId)
                        .eq('device_entity_id', session.device_entity_id)
                        .maybeSingle();

                    const batteryCapacity = currentParams?.battery_capacity_kwh || 75.0;
                    const currentSpeed = currentParams?.avg_charging_speed_kw || 11.0;
                    const sampleCount = currentParams?.sample_count || 0;

                    const result = calculateChargingSpeed(history, batteryCapacity);
                    if (!result) {
                        await supabase.from('energy_schedules').update({ status: 'learned' }).eq('id', session.id);
                        continue;
                    }

                    const newSpeed = (currentSpeed * sampleCount + result.speedKw) / (sampleCount + 1);
                    const newSampleCount = sampleCount + 1;

                    await supabase
                        .from('charging_params')
                        .upsert({
                            connection_id: connectionId,
                            device_entity_id: session.device_entity_id,
                            battery_capacity_kwh: batteryCapacity,
                            avg_charging_speed_kw: Math.round(newSpeed * 100) / 100,
                            sample_count: newSampleCount,
                            last_updated: new Date().toISOString()
                        }, { onConflict: 'connection_id,device_entity_id' });

                    // Mark session as learned so future runs never double-count it
                    await supabase.from('energy_schedules').update({ status: 'learned' }).eq('id', session.id);

                    results.push({
                        device: session.device_entity_id,
                        session_id: session.id,
                        measured_speed: result.speedKw.toFixed(2),
                        new_avg_speed: newSpeed.toFixed(2),
                        samples: newSampleCount,
                        pct_change: `${result.startPct}% → ${result.endPct}%`
                    });
                } catch (sessionErr: any) {
                    console.error(`[Learn Energy] Session error: ${sessionErr.message}`);
                }
            }
        }

        return new Response(JSON.stringify({
            success: true,
            learned: results.length,
            message: results.length > 0
                ? `${results.length} laadsessie(s) gekalibreerd.`
                : "Geen nieuwe meetbare laadsessies gevonden.",
            details: results
        }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });

    } catch (err: any) {
        console.error("[Learn Energy] Error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }
});
