/**
 * Learn Climate - Thermal Learning System
 * Analyzes heating cycles from Home Assistant history and stores contextual heating rates.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from '../_shared/auth.ts';
import { fetchHAStates } from '../_shared/ha-api.ts';
import { fetchWithTimeout } from '../_shared/model-registry.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function getHumidityBucket(humidity: number): string {
    if (humidity < 40) return 'low';
    if (humidity < 70) return 'med';
    return 'high';
}

function getOutsideTempBucket(temp: number): number {
    const clamped = Math.max(-20, Math.min(24, temp));
    return Math.floor(clamped / 2) * 2;
}

function getRoomTempBucket(temp: number): number {
    return Math.max(10, Math.min(25, Math.round(temp)));
}

function isOlderThanYear(lastUpdated: string): boolean {
    const yearMs = 365 * 24 * 60 * 60 * 1000;
    return Date.now() - new Date(lastUpdated).getTime() >= yearMs;
}

function parseFinite(val: any): number | null {
    const n = typeof val === 'number' ? val : parseFloat(String(val));
    return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
    }

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
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

        let connections: any[] = [];
        if (requestedConnectionId) {
            const ownership = await verifyConnectionOwnership(supabase, auth, requestedConnectionId);
            if (!ownership.valid) {
                return new Response(JSON.stringify({ error: ownership.error }), {
                    status: ownership.status || 403,
                    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
                });
            }
            connections = [ownership.connection];
        } else if (auth.isServiceOrCron) {
            const { data } = await supabase.from('ha_connections').select('*');
            connections = data || [];
        } else if (auth.userId) {
            const { data } = await supabase.from('ha_connections').select('*').eq('user_id', auth.userId);
            connections = data || [];
        }

        if (connections.length === 0) {
            return new Response(JSON.stringify({ success: true, message: "Geen koppelingen gevonden.", stats: [] }), {
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        const stats: any[] = [];
        let totalCycles = 0;

        for (const conn of connections) {
            try {
                if (!conn.api_url || !conn.api_token) continue;
                const baseUrl = conn.api_url.replace(/\/+$/, '');

                const allStates = await fetchHAStates(conn);
                const climateEntities = allStates.filter((e: any) => e.entity_id?.startsWith('climate.'));

                const outdoorEntity = allStates.find((e: any) =>
                    (e.entity_id?.includes('outdoor') && e.attributes?.unit_of_measurement === "°C") ||
                    e.entity_id?.startsWith('weather.')
                );

                const humiditySensors = allStates.filter((e: any) =>
                    e.attributes?.unit_of_measurement === '%' &&
                    e.attributes?.device_class === 'humidity'
                );

                if (climateEntities.length === 0) {
                    stats.push({ id: conn.id, status: "skipped_no_climate" });
                    continue;
                }

                // Fetch 7 days of FULL history — IMPORTANT: omit `minimal_response` completely so HA includes attributes!
                const startTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
                const entityIds = [
                    ...climateEntities.map((e: any) => e.entity_id),
                    ...(outdoorEntity ? [outdoorEntity.entity_id] : []),
                    ...humiditySensors.slice(0, 10).map((e: any) => e.entity_id)
                ];

                const historyUrl = `${baseUrl}/api/history/period/${encodeURIComponent(startTime)}?filter_entity_id=${encodeURIComponent(entityIds.join(','))}`;
                const histRes = await fetchWithTimeout(historyUrl, {
                    headers: { "Authorization": `Bearer ${conn.api_token}` }
                }, 25000);

                if (!histRes.ok) {
                    throw new Error(`HA history fetch failed: ${histRes.status}`);
                }
                const historyData = await histRes.json();
                if (!Array.isArray(historyData)) {
                    throw new Error("Invalid HA history payload");
                }

                let insertCount = 0;
                let skipCount = 0;
                let updateCount = 0;

                for (const climateEntity of climateEntities) {
                    const climateHist = historyData.find((arr: any[]) =>
                        Array.isArray(arr) && arr.length > 0 && arr[0].entity_id === climateEntity.entity_id
                    );

                    if (!climateHist || climateHist.length < 10) continue;

                    const room = climateEntity.entity_id.replace('climate.', '');
                    const hasHvacAction = climateHist.some((s: any) => s.attributes?.hvac_action !== undefined);

                    const heatingCycles: any[] = [];
                    let currentCycle: any = null;

                    for (let i = 0; i < climateHist.length; i++) {
                        const state = climateHist[i];
                        // Prefer true active heating (`hvac_action === 'heating'`) over setpoint mode (`state === 'heat'`)
                        const isHeating = hasHvacAction
                            ? state.attributes?.hvac_action === 'heating'
                            : state.state === 'heat';
                        const currentTemp = parseFinite(state.attributes?.current_temperature);
                        const timestamp = new Date(state.last_updated || state.last_changed).getTime();
                        if (!Number.isFinite(timestamp)) continue;

                        if (isHeating && !currentCycle && currentTemp !== null) {
                            const outsideTemp = getOutsideTemp(historyData, outdoorEntity?.entity_id, timestamp);
                            const roomHumidity = getRoomHumidity(historyData, humiditySensors, room, timestamp);
                            const outsideHumidity = getOutsideHumidity(historyData, outdoorEntity?.entity_id, timestamp);

                            currentCycle = {
                                start: timestamp,
                                startTemp: currentTemp,
                                outsideTemp,
                                roomHumidity,
                                outsideHumidity
                            };
                        } else if (!isHeating && currentCycle && currentTemp !== null) {
                            currentCycle.end = timestamp;
                            currentCycle.endTemp = currentTemp;

                            const durationMins = (currentCycle.end - currentCycle.start) / 60000;
                            const tempDiff = currentCycle.endTemp - currentCycle.startTemp;

                            if (durationMins > 10 && durationMins < 720 && tempDiff > 0.5) {
                                heatingCycles.push({
                                    ...currentCycle,
                                    durationMins,
                                    tempDiff,
                                    heatingRate: tempDiff / durationMins
                                });
                            }
                            currentCycle = null;
                        }
                    }

                    for (const cycle of heatingCycles) {
                        const bucketKey = {
                            connection_id: conn.id,
                            room,
                            room_temp_bucket: getRoomTempBucket(cycle.startTemp),
                            room_humidity_bucket: getHumidityBucket(cycle.roomHumidity ?? 50),
                            outside_temp_bucket: getOutsideTempBucket(cycle.outsideTemp ?? 10),
                            outside_humidity_bucket: getHumidityBucket(cycle.outsideHumidity ?? 50)
                        };

                        const { data: existing } = await supabase
                            .from('climate_heating_rates')
                            .select('id, last_updated, avg_heating_rate, sample_count')
                            .match(bucketKey)
                            .maybeSingle();

                        if (!existing) {
                            await supabase.from('climate_heating_rates').insert({
                                ...bucketKey,
                                avg_heating_rate: cycle.heatingRate,
                                sample_count: 1
                            });
                            insertCount++;
                        } else if (isOlderThanYear(existing.last_updated)) {
                            const newAvg = (existing.avg_heating_rate * existing.sample_count + cycle.heatingRate) / (existing.sample_count + 1);
                            await supabase.from('climate_heating_rates').update({
                                avg_heating_rate: newAvg,
                                sample_count: existing.sample_count + 1,
                                last_updated: new Date().toISOString()
                            }).eq('id', existing.id);
                            updateCount++;
                        } else {
                            skipCount++;
                        }
                    }
                }

                const found = insertCount + skipCount + updateCount;
                totalCycles += found;
                stats.push({
                    id: conn.id,
                    status: "processed",
                    cycles_found: found,
                    inserted: insertCount,
                    updated: updateCount,
                    skipped: skipCount
                });

            } catch (e: any) {
                console.error(`Error learning for ${conn.id}`, e);
                stats.push({ id: conn.id, error: e.message });
            }
        }

        return new Response(JSON.stringify({
            success: true,
            message: `Klimaat-analyse voltooid: ${totalCycles} verwarmingscycli verwerkt.`,
            stats
        }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });

    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
    }
});

function getOutsideTemp(historyData: any[], entityId: string | undefined, timestamp: number): number | null {
    if (!entityId) return null;
    const hist = historyData.find((arr: any[]) => Array.isArray(arr) && arr.length > 0 && arr[0].entity_id === entityId);
    if (!hist) return null;

    for (let i = hist.length - 1; i >= 0; i--) {
        if (new Date(hist[i].last_updated || hist[i].last_changed).getTime() <= timestamp) {
            return parseFinite(hist[i].attributes?.temperature) ?? parseFinite(hist[i].state);
        }
    }
    return null;
}

function getRoomHumidity(historyData: any[], sensors: any[], room: string, timestamp: number): number | null {
    const sensor = sensors.find((s: any) => s.entity_id?.includes(room));
    if (!sensor) return null;

    const hist = historyData.find((arr: any[]) => Array.isArray(arr) && arr.length > 0 && arr[0].entity_id === sensor.entity_id);
    if (!hist) return null;

    for (let i = hist.length - 1; i >= 0; i--) {
        if (new Date(hist[i].last_updated || hist[i].last_changed).getTime() <= timestamp) {
            return parseFinite(hist[i].state);
        }
    }
    return null;
}

function getOutsideHumidity(historyData: any[], entityId: string | undefined, timestamp: number): number | null {
    if (!entityId) return null;
    const hist = historyData.find((arr: any[]) => Array.isArray(arr) && arr.length > 0 && arr[0].entity_id === entityId);
    if (!hist) return null;

    for (let i = hist.length - 1; i >= 0; i--) {
        if (new Date(hist[i].last_updated || hist[i].last_changed).getTime() <= timestamp) {
            return parseFinite(hist[i].attributes?.humidity);
        }
    }
    return null;
}
