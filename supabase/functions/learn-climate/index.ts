/**
 * Learn Climate - Thermal Learning System
 * 
 * Analyzes heating cycles from Home Assistant history and stores
 * contextual heating rates for AI-powered heating time predictions.
 * 
 * Run weekly via scheduled job or manual trigger.
 * 
 * Update Strategy:
 * - INSERT: New bucket combinations (fill gaps)
 * - SKIP: Existing data updated < 365 days ago (stable)
 * - UPDATE: Existing data ≥ 365 days old (capture renovations)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2.38.4"

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

// Bucket helper functions
function getHumidityBucket(humidity: number): string {
    if (humidity < 40) return 'low';
    if (humidity < 70) return 'med';
    return 'high';
}

function getOutsideTempBucket(temp: number): number {
    // Bucket per 2°C, even numbers from -20 to 24
    const clamped = Math.max(-20, Math.min(24, temp));
    return Math.floor(clamped / 2) * 2;
}

function getRoomTempBucket(temp: number): number {
    // Bucket per 1°C, clamped to 10-25
    return Math.max(10, Math.min(25, Math.round(temp)));
}

// Check if data is older than 365 days
function isOlderThanYear(lastUpdated: string): boolean {
    const yearMs = 365 * 24 * 60 * 60 * 1000;
    return Date.now() - new Date(lastUpdated).getTime() >= yearMs;
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders })
    }

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

        // Get connections
        const { data: connections } = await supabase.from('ha_connections').select('*');
        if (!connections || connections.length === 0) {
            return new Response(JSON.stringify({ message: "No connections" }), { headers: corsHeaders });
        }

        const stats: any[] = [];

        for (const conn of connections) {
            try {
                if (!conn.api_url || !conn.api_token) continue;

                // 1. Fetch current states to identify entities
                const statesRes = await fetch(`${conn.api_url}/api/states`, {
                    headers: { "Authorization": `Bearer ${conn.api_token}` }
                });
                const allStates = await statesRes.json();

                // Find climate entities
                const climateEntities = allStates.filter((e: any) => e.entity_id.startsWith('climate.'));

                // Find outdoor weather/sensor
                const outdoorEntity = allStates.find((e: any) =>
                    (e.entity_id.includes('outdoor') && e.attributes.unit_of_measurement === "°C") ||
                    e.entity_id.startsWith('weather.')
                );

                // Find humidity sensors per room
                const humiditySensors = allStates.filter((e: any) =>
                    e.attributes?.unit_of_measurement === '%' &&
                    e.attributes?.device_class === 'humidity'
                );

                if (climateEntities.length === 0) {
                    stats.push({ id: conn.id, status: "skipped_no_climate" });
                    continue;
                }

                // 2. Fetch 7 days of history (HA default retention)
                const startTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
                const entityIds = [
                    ...climateEntities.map((e: any) => e.entity_id),
                    ...(outdoorEntity ? [outdoorEntity.entity_id] : []),
                    ...humiditySensors.map((e: any) => e.entity_id)
                ];

                const historyUrl = `${conn.api_url}/api/history/period/${startTime}?filter_entity_id=${entityIds.join(',')}&minimal_response=false`;
                const histRes = await fetch(historyUrl, {
                    headers: { "Authorization": `Bearer ${conn.api_token}` }
                });
                const historyData = await histRes.json();

                // 3. Process each climate entity
                let insertCount = 0;
                let skipCount = 0;
                let updateCount = 0;

                for (const climateEntity of climateEntities) {
                    const climateHist = historyData.find((arr: any[]) =>
                        arr.length > 0 && arr[0].entity_id === climateEntity.entity_id
                    );

                    if (!climateHist || climateHist.length < 10) continue;

                    // Extract room name from entity_id (e.g., climate.living_room -> living_room)
                    const room = climateEntity.entity_id.replace('climate.', '');

                    // Find heating cycles
                    const heatingCycles: any[] = [];
                    let currentCycle: any = null;

                    for (let i = 0; i < climateHist.length; i++) {
                        const state = climateHist[i];
                        const isHeating = state.attributes?.hvac_action === 'heating' || state.state === 'heat';
                        const currentTemp = state.attributes?.current_temperature;
                        const timestamp = new Date(state.last_updated).getTime();

                        if (isHeating && !currentCycle && currentTemp) {
                            // Start of heating cycle - capture context
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
                        } else if (!isHeating && currentCycle) {
                            // End of heating cycle
                            currentCycle.end = timestamp;
                            currentCycle.endTemp = currentTemp;

                            const durationMins = (currentCycle.end - currentCycle.start) / 60000;
                            const tempDiff = currentCycle.endTemp - currentCycle.startTemp;

                            // Validate cycle (> 10 mins, positive temp change)
                            if (durationMins > 10 && tempDiff > 0.5) {
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

                    // 4. Store each cycle with bucket logic
                    for (const cycle of heatingCycles) {
                        const bucketKey = {
                            connection_id: conn.id,
                            room,
                            room_temp_bucket: getRoomTempBucket(cycle.startTemp),
                            room_humidity_bucket: getHumidityBucket(cycle.roomHumidity ?? 50),
                            outside_temp_bucket: getOutsideTempBucket(cycle.outsideTemp ?? 10),
                            outside_humidity_bucket: getHumidityBucket(cycle.outsideHumidity ?? 50)
                        };

                        // Check if bucket exists
                        const { data: existing } = await supabase
                            .from('climate_heating_rates')
                            .select('id, last_updated, avg_heating_rate, sample_count')
                            .match(bucketKey)
                            .single();

                        if (!existing) {
                            // NEW bucket - INSERT
                            await supabase.from('climate_heating_rates').insert({
                                ...bucketKey,
                                avg_heating_rate: cycle.heatingRate,
                                sample_count: 1
                            });
                            insertCount++;
                        } else if (isOlderThanYear(existing.last_updated)) {
                            // OLD data - UPDATE with weighted average
                            const newAvg = (existing.avg_heating_rate * existing.sample_count + cycle.heatingRate) / (existing.sample_count + 1);
                            await supabase.from('climate_heating_rates').update({
                                avg_heating_rate: newAvg,
                                sample_count: existing.sample_count + 1,
                                last_updated: new Date().toISOString()
                            }).eq('id', existing.id);
                            updateCount++;
                        } else {
                            // Recent data - SKIP
                            skipCount++;
                        }
                    }
                }

                stats.push({
                    id: conn.id,
                    status: "processed",
                    cycles_found: insertCount + skipCount + updateCount,
                    inserted: insertCount,
                    updated: updateCount,
                    skipped: skipCount
                });

            } catch (e: any) {
                console.error(`Error learning for ${conn.id}`, e);
                stats.push({ id: conn.id, error: e.message });
            }
        }

        return new Response(JSON.stringify(stats), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
    }
})

// Helper: Get outside temperature at a specific timestamp
function getOutsideTemp(historyData: any[], entityId: string | undefined, timestamp: number): number | null {
    if (!entityId) return null;
    const hist = historyData.find((arr: any[]) => arr.length > 0 && arr[0].entity_id === entityId);
    if (!hist) return null;

    // Find closest state before timestamp
    for (let i = hist.length - 1; i >= 0; i--) {
        if (new Date(hist[i].last_updated).getTime() <= timestamp) {
            // Weather entities store temp in attributes, sensors in state
            return hist[i].attributes?.temperature ?? parseFloat(hist[i].state) ?? null;
        }
    }
    return null;
}

// Helper: Get room humidity at a specific timestamp
function getRoomHumidity(historyData: any[], sensors: any[], room: string, timestamp: number): number | null {
    // Find humidity sensor for this room
    const sensor = sensors.find((s: any) => s.entity_id.includes(room));
    if (!sensor) return null;

    const hist = historyData.find((arr: any[]) => arr.length > 0 && arr[0].entity_id === sensor.entity_id);
    if (!hist) return null;

    for (let i = hist.length - 1; i >= 0; i--) {
        if (new Date(hist[i].last_updated).getTime() <= timestamp) {
            return parseFloat(hist[i].state) ?? null;
        }
    }
    return null;
}

// Helper: Get outside humidity at a specific timestamp
function getOutsideHumidity(historyData: any[], entityId: string | undefined, timestamp: number): number | null {
    if (!entityId) return null;
    const hist = historyData.find((arr: any[]) => arr.length > 0 && arr[0].entity_id === entityId);
    if (!hist) return null;

    for (let i = hist.length - 1; i >= 0; i--) {
        if (new Date(hist[i].last_updated).getTime() <= timestamp) {
            return hist[i].attributes?.humidity ?? null;
        }
    }
    return null;
}
