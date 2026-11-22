/**
 * Detect Anomalies - Smart sensor anomaly detection
 * Endpoints: POST /learn, POST /detect, GET/POST /status
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from '../_shared/auth.ts';
import { fetchHAStates } from '../_shared/ha-api.ts';
import { fetchWithTimeout } from '../_shared/model-registry.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MONITORED_PATTERNS = [
    { pattern: /^sensor\..*_power$/, type: 'power' },
    { pattern: /^sensor\..*_temperature$/, type: 'temperature' },
    { pattern: /^sensor\..*_humidity$/, type: 'humidity' },
    { pattern: /^sensor\..*consumption/, type: 'power' },
    { pattern: /^sensor\..*watt/, type: 'power' },
];

const ANOMALY_COOLDOWN_MS = 2 * 60 * 60 * 1000;

interface Baseline {
    entity_id: string;
    entity_type: string;
    mean_value: number;
    stddev: number;
    min_value: number;
    max_value: number;
    sample_count: number;
}

function jsonResponse(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
}

function detectSensorType(entityId: string): string | null {
    for (const p of MONITORED_PATTERNS) {
        if (p.pattern.test(entityId)) return p.type;
    }
    return null;
}

function calculateStats(values: number[]): { mean: number; stddev: number; min: number; max: number } {
    if (values.length === 0) return { mean: 0, stddev: 0, min: 0, max: 0 };

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const mean = sum / values.length;
    let sqSum = 0;
    for (const v of values) {
        sqSum += (v - mean) * (v - mean);
    }
    const stddev = Math.sqrt(sqSum / values.length);
    return { mean, stddev, min, max };
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/detect-anomalies/, '') || '/detect';

    try {
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) return jsonResponse({ error: auth.error }, auth.status || 401);

        let body: any = {};
        if (req.method === 'POST') {
            const raw = await req.text().catch(() => '');
            if (raw.trim()) {
                try { body = JSON.parse(raw); } catch { body = {}; }
            }
        }
        const connectionId = url.searchParams.get('connection_id') || body.connection_id;
        if (!connectionId) return jsonResponse({ error: 'connection_id required' }, 400);

        const ownership = await verifyConnectionOwnership(supabase, auth, connectionId);
        if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);
        const conn = ownership.connection;
        const baseUrl = conn.api_url.replace(/\/+$/, '');

        // =============================================
        // POST /learn - Learn baselines from HA history
        // =============================================
        if (path === '/learn' && req.method === 'POST') {
            const states = await fetchHAStates(conn);
            const learned: Baseline[] = [];

            const sensors = states.filter((s: any) => {
                // Skip cumulative total_increasing counters (e.g. lifetime kWh meters)
                if (s.attributes?.state_class === 'total_increasing' || s.attributes?.state_class === 'total') return false;
                const type = detectSensorType(s.entity_id || '');
                return type !== null && !isNaN(parseFloat(s.state));
            }).slice(0, 30);

            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const CONCURRENCY = 5;

            for (let i = 0; i < sensors.length; i += CONCURRENCY) {
                const batch = sensors.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (sensor: any) => {
                    try {
                        const historyUrl = `${baseUrl}/api/history/period/${encodeURIComponent(sevenDaysAgo)}?filter_entity_id=${encodeURIComponent(sensor.entity_id)}&minimal_response&no_attributes`;
                        const histRes = await fetchWithTimeout(historyUrl, {
                            headers: { "Authorization": `Bearer ${conn.api_token}` }
                        }, 12000);

                        if (!histRes.ok) return;
                        const histData = await histRes.json();
                        const history = histData?.[0] || [];

                        const values = history
                            .map((h: any) => parseFloat(h.state))
                            .filter((v: number) => Number.isFinite(v));

                        if (values.length < 10) return;

                        const stats = calculateStats(values);
                        const entityType = detectSensorType(sensor.entity_id) || 'unknown';

                        await supabase.from('anomaly_baselines').upsert({
                            connection_id: connectionId,
                            entity_id: sensor.entity_id,
                            entity_type: entityType,
                            mean_value: Math.round(stats.mean * 100) / 100,
                            stddev: Math.round(stats.stddev * 100) / 100,
                            min_value: stats.min,
                            max_value: stats.max,
                            sample_count: values.length,
                            last_updated: new Date().toISOString()
                        }, { onConflict: 'connection_id,entity_id' });

                        learned.push({
                            entity_id: sensor.entity_id,
                            entity_type: entityType,
                            mean_value: stats.mean,
                            stddev: stats.stddev,
                            min_value: stats.min,
                            max_value: stats.max,
                            sample_count: values.length
                        });
                    } catch (e) {
                        console.error(`[Anomaly] Error learning ${sensor.entity_id}:`, e);
                    }
                }));
            }

            return jsonResponse({
                success: true,
                learned: learned.length,
                message: `${learned.length} sensor-baselines geleerd.`,
                sensors: learned.map(l => ({
                    entity_id: l.entity_id,
                    type: l.entity_type,
                    mean: l.mean_value.toFixed(1),
                    stddev: l.stddev.toFixed(1)
                }))
            });
        }

        // =============================================
        // POST /detect (or /) - Check current values for anomalies
        // =============================================
        if ((path === '/detect' || path === '/') && req.method === 'POST') {
            const { data: baselines } = await supabase
                .from('anomaly_baselines')
                .select('*')
                .eq('connection_id', connectionId);

            if (!baselines || baselines.length === 0) {
                return jsonResponse({
                    success: true,
                    message: 'Nog geen baselines geleerd. Start eerst /learn om sensor-normaalwaarden te leren.',
                    anomalies: []
                });
            }

            const states = await fetchHAStates(conn);
            const stateMap = new Map(states.map((s: any) => [s.entity_id, s]));

            // Fetch recent anomaly events within cooldown window to avoid duplicate alert spam
            const cooldownCutoff = new Date(Date.now() - ANOMALY_COOLDOWN_MS).toISOString();
            const { data: recentEvents } = await supabase
                .from('anomaly_events')
                .select('entity_id')
                .eq('connection_id', connectionId)
                .gte('created_at', cooldownCutoff);
            const recentlyAlerted = new Set((recentEvents || []).map((e: any) => e.entity_id));

            const anomalies: any[] = [];

            for (const baseline of baselines) {
                const current: any = stateMap.get(baseline.entity_id);
                if (!current) continue;
                if (current.attributes?.state_class === 'total_increasing') continue;

                const currentValue = parseFloat(current.state);
                if (!Number.isFinite(currentValue)) continue;

                const deviation = Math.abs(currentValue - baseline.mean_value);
                let sigma = 0;
                if (baseline.stddev > 0.001) {
                    sigma = deviation / baseline.stddev;
                } else if (deviation > Math.max(1.0, Math.abs(baseline.mean_value) * 0.25)) {
                    // Constant baseline (stddev == 0) suddenly jumped significantly
                    sigma = 3.5;
                }

                if (sigma >= 2.2) {
                    const severity = sigma >= 3.2 ? 'critical' : 'warning';
                    const direction = currentValue > baseline.mean_value ? 'hoger' : 'lager';
                    const unit = current.attributes?.unit_of_measurement || '';
                    const message = `${current.attributes?.friendly_name || baseline.entity_id} is ${currentValue}${unit} (${direction} dan normaal ${baseline.mean_value.toFixed(1)}${unit})`;

                    anomalies.push({
                        entity_id: baseline.entity_id,
                        current_value: currentValue,
                        baseline_mean: baseline.mean_value,
                        baseline_stddev: baseline.stddev,
                        deviation_sigma: Math.round(sigma * 10) / 10,
                        severity,
                        message
                    });

                    if (!recentlyAlerted.has(baseline.entity_id)) {
                        await supabase.from('anomaly_events').insert({
                            connection_id: connectionId,
                            entity_id: baseline.entity_id,
                            detected_value: currentValue,
                            baseline_mean: baseline.mean_value,
                            baseline_stddev: baseline.stddev,
                            deviation_sigma: sigma,
                            severity,
                            message
                        });
                        recentlyAlerted.add(baseline.entity_id);
                    }
                }
            }

            return jsonResponse({
                success: true,
                checked: baselines.length,
                anomalies,
                message: anomalies.length > 0
                    ? `${anomalies.length} afwijking(en) gevonden uit ${baselines.length} sensoren.`
                    : `Alles normaal (${baselines.length} sensoren gecontroleerd).`
            });
        }

        // =============================================
        // GET/POST /status - Get recent anomalies
        // =============================================
        if (path === '/status') {
            const hours = parseInt(url.searchParams.get('hours') || String(body.hours || '24'), 10);
            const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

            const { data: events } = await supabase
                .from('anomaly_events')
                .select('*')
                .eq('connection_id', connectionId)
                .gte('created_at', since)
                .order('created_at', { ascending: false })
                .limit(50);

            const { data: baselines } = await supabase
                .from('anomaly_baselines')
                .select('entity_id, entity_type, mean_value, stddev')
                .eq('connection_id', connectionId);

            return jsonResponse({
                success: true,
                baselines_count: baselines?.length || 0,
                recent_anomalies: events || [],
                period_hours: hours
            });
        }

        return jsonResponse({ error: 'Endpoint not found', path }, 404);

    } catch (err: any) {
        console.error('[Anomaly] Error:', err);
        return jsonResponse({ error: err.message }, 500);
    }
});
