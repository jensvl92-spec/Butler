/**
 * Learn Energy - Charging Speed Learning System
 * 
 * Analyzes completed charging sessions to learn real-world charging speeds.
 * Updates charging_params table with improved estimates.
 * 
 * Logic:
 * 1. Find completed energy_schedules from last 7 days
 * 2. For each, fetch HA history for the battery sensor
 * 3. Calculate actual % change during the scheduled window
 * 4. Derive real charging speed and update charging_params
 * 
 * Run weekly via pg_cron
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2.38.4"

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

interface ChargingSession {
    id: string;
    connection_id: string;
    device_entity_id: string;
    battery_entity_id: string;
    start_time: string;
    duration_minutes: number;
    target_percent: number;
}

interface LearnedSpeed {
    device_entity_id: string;
    calculated_speed_kw: number;
    start_pct: number;
    end_pct: number;
    duration_hours: number;
}

async function fetchHAHistory(
    apiUrl: string,
    token: string,
    entityId: string,
    startTime: Date,
    endTime: Date
): Promise<any[]> {
    const url = `${apiUrl}/api/history/period/${startTime.toISOString()}?filter_entity_id=${entityId}&end_time=${endTime.toISOString()}`;

    const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${token}` }
    });

    if (!res.ok) return [];

    const data = await res.json();
    // HA returns [[{state, last_changed, ...}, ...]]
    return data[0] || [];
}

function calculateChargingSpeed(
    historyPoints: any[],
    batteryCapacityKwh: number,
    scheduledDurationMinutes: number
): { speedKw: number; startPct: number; endPct: number } | null {
    if (historyPoints.length < 2) return null;

    // Get first and last valid numeric states
    const validPoints = historyPoints
        .filter(p => !isNaN(parseFloat(p.state)))
        .map(p => ({ pct: parseFloat(p.state), time: new Date(p.last_changed) }));

    if (validPoints.length < 2) return null;

    const startPct = validPoints[0].pct;
    const endPct = validPoints[validPoints.length - 1].pct;

    // If battery didn't increase, charging didn't happen or already full
    if (endPct <= startPct) return null;

    const pctGained = endPct - startPct;
    const kwhDelivered = (pctGained / 100) * batteryCapacityKwh;

    // Use actual time span from history, not scheduled duration
    const actualDurationMs = validPoints[validPoints.length - 1].time.getTime() - validPoints[0].time.getTime();
    const actualDurationHours = actualDurationMs / (1000 * 60 * 60);

    if (actualDurationHours < 0.1) return null; // Too short to be meaningful

    const speedKw = kwhDelivered / actualDurationHours;

    // Sanity check: speed should be between 1kW and 350kW (supercharger)
    if (speedKw < 1 || speedKw > 350) return null;

    return { speedKw, startPct, endPct };
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const results: any[] = [];

    try {
        console.log("[Learn Energy] Starting learning cycle...");

        // 1. Get all connections with charging schedules
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        const { data: schedules, error: schedError } = await supabase
            .from('energy_schedules')
            .select('*')
            .gte('start_time', sevenDaysAgo)
            .not('battery_entity_id', 'is', null)
            .not('target_percent', 'is', null);

        if (schedError) throw schedError;

        if (!schedules || schedules.length === 0) {
            console.log("[Learn Energy] No charging schedules with battery sensors found.");
            return new Response(JSON.stringify({ message: "No sessions to learn from", learned: 0 }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        console.log(`[Learn Energy] Found ${schedules.length} charging schedules to analyze.`);

        // Group by connection_id for efficiency
        const byConnection: Record<string, ChargingSession[]> = {};
        for (const s of schedules) {
            if (!byConnection[s.connection_id]) byConnection[s.connection_id] = [];
            byConnection[s.connection_id].push(s);
        }

        // 2. Process each connection
        for (const [connectionId, sessions] of Object.entries(byConnection)) {
            // Get connection details
            const { data: conn } = await supabase
                .from('ha_connections')
                .select('api_url, api_token')
                .eq('id', connectionId)
                .single();

            if (!conn) continue;

            // Process each session
            for (const session of sessions) {
                try {
                    const startTime = new Date(session.start_time);
                    const endTime = new Date(startTime.getTime() + session.duration_minutes * 60 * 1000);

                    // Skip if session hasn't ended yet
                    if (endTime > new Date()) continue;

                    // Fetch battery history
                    const history = await fetchHAHistory(
                        conn.api_url,
                        conn.api_token,
                        session.battery_entity_id,
                        startTime,
                        endTime
                    );

                    if (history.length === 0) {
                        console.log(`[Learn Energy] No history for ${session.battery_entity_id}`);
                        continue;
                    }

                    // Get current learned params
                    const { data: currentParams } = await supabase
                        .from('charging_params')
                        .select('*')
                        .eq('connection_id', connectionId)
                        .eq('device_entity_id', session.device_entity_id)
                        .single();

                    const batteryCapacity = currentParams?.battery_capacity_kwh || 75.0;
                    const currentSpeed = currentParams?.avg_charging_speed_kw || 11.0;
                    const sampleCount = currentParams?.sample_count || 0;

                    // Calculate speed from this session
                    const result = calculateChargingSpeed(history, batteryCapacity, session.duration_minutes);

                    if (!result) {
                        console.log(`[Learn Energy] Could not calculate speed for ${session.device_entity_id}`);
                        continue;
                    }

                    // Weighted average: give more weight to existing data
                    // new_avg = (old_avg * sample_count + new_value) / (sample_count + 1)
                    const newSpeed = (currentSpeed * sampleCount + result.speedKw) / (sampleCount + 1);
                    const newSampleCount = sampleCount + 1;

                    // Update charging_params
                    await supabase
                        .from('charging_params')
                        .upsert({
                            connection_id: connectionId,
                            device_entity_id: session.device_entity_id,
                            battery_capacity_kwh: batteryCapacity,
                            avg_charging_speed_kw: Math.round(newSpeed * 100) / 100, // 2 decimals
                            sample_count: newSampleCount,
                            last_updated: new Date().toISOString()
                        }, { onConflict: 'connection_id, device_entity_id' });

                    results.push({
                        device: session.device_entity_id,
                        session_id: session.id,
                        measured_speed: result.speedKw.toFixed(2),
                        new_avg_speed: newSpeed.toFixed(2),
                        samples: newSampleCount,
                        pct_change: `${result.startPct}% → ${result.endPct}%`
                    });

                    console.log(`[Learn Energy] Learned: ${session.device_entity_id} = ${newSpeed.toFixed(2)}kW (sample #${newSampleCount})`);

                } catch (sessionErr: any) {
                    console.error(`[Learn Energy] Session error: ${sessionErr.message}`);
                }
            }
        }

        console.log(`[Learn Energy] Complete. Learned from ${results.length} sessions.`);

        return new Response(JSON.stringify({
            success: true,
            learned: results.length,
            details: results
        }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (err: any) {
        console.error("[Learn Energy] Error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
});
