import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2.38.4"

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const LLM_API_KEY = Deno.env.get("LLM_API_KEY")!

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders })
    }

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

        // 1. Get Connections
        const { data: connections } = await supabase.from('ha_connections').select('*');
        if (!connections || connections.length === 0) {
            return new Response(JSON.stringify({ message: "No connections" }), { headers: corsHeaders });
        }

        const stats = [];

        for (const conn of connections) {
            try {
                if (!conn.api_url || !conn.api_token) continue;

                // 2. Identify relevant entities
                // We need a thermostat and an outdoor sensor
                const statesRes = await fetch(`${conn.api_url}/api/states`, {
                    headers: { "Authorization": `Bearer ${conn.api_token}` }
                });
                const allStates = await statesRes.json();

                // Find first climate entity
                const climateEntity = allStates.find((e: any) => e.entity_id.startsWith('climate.'));
                // Find candidate outdoor sensor (naive)
                const outdoorEntity = allStates.find((e: any) =>
                    e.entity_id.includes('outdoor') && e.attributes.unit_of_measurement === "°C"
                ) || allStates.find((e: any) => e.entity_id.startsWith('weather.')); // Fallback

                if (!climateEntity) {
                    stats.push({ id: conn.id, status: "skipped_no_climate" });
                    continue;
                }

                // 3. Fetch History (Last 24h)
                const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const entityIds = [climateEntity.entity_id];
                if (outdoorEntity) entityIds.push(outdoorEntity.entity_id);

                const historyUrl = `${conn.api_url}/api/history/period/${startTime}?filter_entity_id=${entityIds.join(',')}&minimal_response=false`; // Need attributes for climate (current_temperature)
                const histRes = await fetch(historyUrl, {
                    headers: { "Authorization": `Bearer ${conn.api_token}` }
                });
                const historyData = await histRes.json();

                // 4. Analyze Cycles
                // historyData is Array<Array<State>>
                const climateHist = historyData.find((arr: any[]) => arr.length > 0 && arr[0].entity_id === climateEntity.entity_id);
                // We need to look for transitions where hvac_action goes 'idle' -> 'heating'

                // Simplification for MVP:
                // Look for continuous blocks where 'hvac_action' (attribute) == 'heating'
                // Calculate delta Temp / delta Time

                let heatingCycles = [];
                let currentCycle: any = null;

                for (const state of climateHist || []) {
                    const isHeating = state.attributes?.hvac_action === 'heating' || state.state === 'heat'; // Support different modes
                    const currentTemp = state.attributes?.current_temperature;
                    const timestamp = new Date(state.last_updated).getTime();

                    if (isHeating && !currentCycle) {
                        // Start
                        currentCycle = { start: timestamp, startTemp: currentTemp };
                    } else if (!isHeating && currentCycle) {
                        // End
                        currentCycle.end = timestamp;
                        currentCycle.endTemp = currentTemp;

                        // Validate cycle (must be > 10 mins and sensible temp shift)
                        const durationMins = (currentCycle.end - currentCycle.start) / 60000;
                        const tempDiff = currentCycle.endTemp - currentCycle.startTemp;

                        if (durationMins > 10 && tempDiff > 0.5) {
                            heatingCycles.push({ ...currentCycle, durationMins, tempDiff });
                        }
                        currentCycle = null;
                    }
                }

                if (heatingCycles.length > 0) {
                    // Average them
                    const avgRate = heatingCycles.reduce((sum, c) => sum + (c.tempDiff / c.durationMins), 0) / heatingCycles.length;
                    // Format: 0.1 deg / min

                    // Create Memory Content
                    const fact = `THERMAL PROPERTY: ${climateEntity.entity_id} heats up at a rate of ${avgRate.toFixed(3)}°C per minute (approx ${(60 / avgRate).toFixed(0)} mins per degree).`;

                    // 5. Embed and Store
                    const embeddingRes = await fetch("https://openrouter.ai/api/v1/embeddings", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${LLM_API_KEY}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            model: "text-embedding-3-small",
                            input: fact
                        })
                    });

                    const embeddingData = await embeddingRes.json();
                    const vector = embeddingData.data?.[0]?.embedding;

                    if (vector) {
                        // Insert into memories
                        await supabase.from('memories').insert({
                            content: fact,
                            embedding: vector,
                            type: 'fact',
                            metadata: { source: 'learn-climate', entity: climateEntity.entity_id }
                        });
                        stats.push({ id: conn.id, status: "learned", fact });
                    }
                } else {
                    stats.push({ id: conn.id, status: "no_heating_cycles_found" });
                }

            } catch (e: any) {
                console.error(`Error learning for ${conn.id}`, e);
                stats.push({ id: conn.id, error: e.message });
            }
        }

        return new Response(JSON.stringify(stats), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
    }
})
