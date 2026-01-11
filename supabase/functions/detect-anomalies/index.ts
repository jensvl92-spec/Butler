/**
 * Detect Anomalies - Smart sensor anomaly detection
 * 
 * Endpoints:
 * - POST /learn     - Learn baseline statistics from HA history
 * - POST /detect    - Check current values against baselines
 * - GET  /status    - Get recent anomalies for a connection
 * 
 * Logic:
 * - Fetches sensor history from HA
 * - Calculates mean and stddev for each sensor
 * - Flags values > 2σ from mean as anomalies
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2.38.4"

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

// Sensor types to monitor
const MONITORED_PATTERNS = [
    { pattern: /^sensor\..*_power$/, type: 'power' },
    { pattern: /^sensor\..*_energy$/, type: 'energy' },
    { pattern: /^sensor\..*_temperature$/, type: 'temperature' },
    { pattern: /^sensor\..*_humidity$/, type: 'humidity' },
    { pattern: /^sensor\..*consumption/, type: 'power' },
    { pattern: /^sensor\..*watt/, type: 'power' },
];

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
        headers: { ...corsHeaders, "Content-Type": "application/json" }
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

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    const stddev = Math.sqrt(variance);

    return {
        mean,
        stddev,
        min: Math.min(...values),
        max: Math.max(...values)
    };
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(req.url);
    const path = url.pathname.replace('/detect-anomalies', '');

    try {
        const body = req.method === 'POST' ? await req.json() : {};
        const connectionId = url.searchParams.get('connection_id') || body.connection_id;

        if (!connectionId) {
            return jsonResponse({ error: 'connection_id required' }, 400);
        }

        // Get HA connection
        const { data: conn } = await supabase
            .from('ha_connections')
            .select('*')
            .eq('id', connectionId)
            .single();

        if (!conn) {
            return jsonResponse({ error: 'Connection not found' }, 404);
        }

        // =============================================
        // POST /learn - Learn baselines from HA history
        // =============================================
        if (path === '/learn' && req.method === 'POST') {
            console.log(`[Anomaly] Learning baselines for connection ${connectionId}`);

            // Fetch current states to get sensor list
            const statesRes = await fetch(`${conn.api_url}/api/states`, {
                headers: { "Authorization": `Bearer ${conn.api_token}` }
            });

            if (!statesRes.ok) {
                return jsonResponse({ error: 'Failed to fetch HA states' }, 502);
            }

            const states = await statesRes.json();
            const learned: Baseline[] = [];

            // Find sensors to learn
            const sensors = states.filter((s: any) => {
                const type = detectSensorType(s.entity_id);
                return type !== null && !isNaN(parseFloat(s.state));
            });

            console.log(`[Anomaly] Found ${sensors.length} sensors to learn`);

            // Fetch 7-day history for each sensor
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

            for (const sensor of sensors.slice(0, 50)) { // Limit to 50 sensors
                try {
                    const historyUrl = `${conn.api_url}/api/history/period/${sevenDaysAgo.toISOString()}?filter_entity_id=${sensor.entity_id}`;
                    const histRes = await fetch(historyUrl, {
                        headers: { "Authorization": `Bearer ${conn.api_token}` }
                    });

                    if (!histRes.ok) continue;

                    const histData = await histRes.json();
                    const history = histData[0] || [];

                    // Extract numeric values
                    const values = history
                        .map((h: any) => parseFloat(h.state))
                        .filter((v: number) => !isNaN(v) && isFinite(v));

                    if (values.length < 10) continue; // Need enough samples

                    const stats = calculateStats(values);
                    const entityType = detectSensorType(sensor.entity_id) || 'unknown';

                    // Upsert baseline
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
                    }, { onConflict: 'connection_id, entity_id' });

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
            }

            console.log(`[Anomaly] Learned ${learned.length} baselines`);

            return jsonResponse({
                success: true,
                learned: learned.length,
                sensors: learned.map(l => ({
                    entity_id: l.entity_id,
                    type: l.entity_type,
                    mean: l.mean_value.toFixed(1),
                    stddev: l.stddev.toFixed(1)
                }))
            });
        }

        // =============================================
        // POST /detect - Check current values for anomalies
        // =============================================
        if (path === '/detect' && req.method === 'POST') {
            console.log(`[Anomaly] Detecting anomalies for connection ${connectionId}`);

            // Get baselines
            const { data: baselines } = await supabase
                .from('anomaly_baselines')
                .select('*')
                .eq('connection_id', connectionId);

            if (!baselines || baselines.length === 0) {
                return jsonResponse({
                    success: true,
                    message: 'No baselines found. Run /learn first.',
                    anomalies: []
                });
            }

            // Fetch current states
            const statesRes = await fetch(`${conn.api_url}/api/states`, {
                headers: { "Authorization": `Bearer ${conn.api_token}` }
            });

            if (!statesRes.ok) {
                return jsonResponse({ error: 'Failed to fetch HA states' }, 502);
            }

            const states = await statesRes.json();
            const stateMap = new Map(states.map((s: any) => [s.entity_id, s]));

            const anomalies: any[] = [];

            for (const baseline of baselines) {
                const current = stateMap.get(baseline.entity_id);
                if (!current) continue;

                const currentValue = parseFloat(current.state);
                if (isNaN(currentValue)) continue;

                // Calculate deviation in standard deviations
                const deviation = Math.abs(currentValue - baseline.mean_value);
                const sigma = baseline.stddev > 0 ? deviation / baseline.stddev : 0;

                // Flag if > 2 standard deviations
                if (sigma >= 2) {
                    const severity = sigma >= 3 ? 'critical' : 'warning';
                    const direction = currentValue > baseline.mean_value ? 'higher' : 'lower';
                    const unit = current.attributes?.unit_of_measurement || '';

                    const message = `${current.attributes?.friendly_name || baseline.entity_id} is ${currentValue}${unit} (${direction} than normal ${baseline.mean_value.toFixed(1)}${unit})`;

                    anomalies.push({
                        entity_id: baseline.entity_id,
                        current_value: currentValue,
                        baseline_mean: baseline.mean_value,
                        baseline_stddev: baseline.stddev,
                        deviation_sigma: Math.round(sigma * 10) / 10,
                        severity,
                        message
                    });

                    // Store anomaly event
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
                }
            }

            console.log(`[Anomaly] Found ${anomalies.length} anomalies`);

            return jsonResponse({
                success: true,
                checked: baselines.length,
                anomalies
            });
        }

        // =============================================
        // GET /status - Get recent anomalies
        // =============================================
        if (path === '/status' && req.method === 'GET') {
            const hours = parseInt(url.searchParams.get('hours') || '24');
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
