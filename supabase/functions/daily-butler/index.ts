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
const LLM_MODEL = Deno.env.get("LLM_MODEL") || "openai/gpt-4o-mini"
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders })
    }

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

        // 1. Determine Mode based on Time (or override via param)
        // Default to checking current hour
        const now = new Date();
        const currentHour = now.getHours();

        let mode = "morning_briefing";
        if (currentHour >= 20 || currentHour < 5) {
            mode = "night_watch";
        }

        // Allow manual override
        const payload = await req.json().catch(() => ({}));
        if (payload.mode) mode = payload.mode;

        console.log(`🕒 Daily Butler running in mode: ${mode}`);

        // 2. Iterate over all connections
        const { data: connections, error: connError } = await supabase
            .from('ha_connections')
            .select('*'); // need api_url, api_token, fcm_token

        if (connError || !connections || connections.length === 0) {
            return new Response(JSON.stringify({ message: "No connections found" }), { headers: corsHeaders })
        }

        const results = [];

        // Import Sync Logic
        const { syncScriptsToDB } = await import("../_shared/ha-api.ts");

        for (const conn of connections) {
            if (!conn.api_url || !conn.api_token || !conn.fcm_token) {
                console.log(`Skipping connection ${conn.id}: Missing credentials`);
                continue;
            }

            try {
                // 2.5 Sync Scripts (Daily)
                await syncScriptsToDB(conn, supabase);

                // 3. Fetch Home State
                // We need a broad view: Weather, Person, Lights, Locks, Covers, Sensors
                const haRes = await fetch(`${conn.api_url}/api/states`, {
                    headers: {
                        "Authorization": `Bearer ${conn.api_token}`,
                        "Content-Type": "application/json"
                    }
                });

                if (!haRes.ok) {
                    console.error(`Failed to fetch HA state for ${conn.id}`);
                    continue;
                }

                const allStates = await haRes.json();

                // Filter relevant entities to reduce context size
                const relevantDomains = ["weather", "person", "climate", "lock", "cover", "binary_sensor", "sensor"];
                const relevantStates = allStates.filter((e: any) => {
                    const domain = e.entity_id.split('.')[0];
                    if (!relevantDomains.includes(domain)) return false;
                    // Filter out boring sensors if needed, or keep all for "Context"
                    return true;
                });

                // Compress state for LLM
                const stateSummary = relevantStates.map((e: any) => `${e.entity_id}: ${e.state} ${e.attributes.friendly_name ? `(${e.attributes.friendly_name})` : ''}`).join('\n');

                // 4. Generate Briefing via LLM
                let systemPrompt = "";

                if (mode === "morning_briefing") {
                    systemPrompt = `
                    You are a classic, helpful British Butler.
                    It is Morning.
                    Your goal is to provide a concise Morning Briefing to the Master/Mistress of the house.
                    
                    Data provided:
                    - Weather
                    - Who is home
                    - House state (temperature, etc)

                    Instructions:
                    1. Greet the user politely (Good Morning).
                    2. Summarize the weather and give a practical tip.
                    3. Mention any anomalies.
                    4. IMPORTANT: Briefly ask "What are your plans for today?" so we can prepare the home.
                    5. Keep it under 40 words.
                    `;
                } else {
                    // Night Watch
                    systemPrompt = `
                    You are a vigilant Night Watchman.
                    It is Night.
                    Your goal is to provide a Night Security Check and Briefing.

                    Data provided:
                    - Weather
                    - Who is home
                    - House state (locks, covers, sensors)

                    Instructions:
                    1. Report on the security status of the house (locks, doors, windows).
                    2. Mention if anyone is still away or if everyone is home.
                    3. Suggest checking any unlocked doors or open windows.
                    4. Wish the user a safe night.
                    5. Keep it under 40 words.
                    `;
                }

                const completionPayload = {
                    model: LLM_MODEL,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: `Current State:\n${stateSummary}` }
                    ],
                    max_tokens: 150
                };

                const llmRes = await fetch(OPENROUTER_API_URL, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${LLM_API_KEY}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": "https://dailybutler.app",
                    },
                    body: JSON.stringify(completionPayload)
                });

                if (!llmRes.ok) {
                    throw new Error(`LLM API Failed: ${llmRes.status} ${await llmRes.text()}`);
                }

                const llmData = await llmRes.json();
                const content = llmData.choices?.[0]?.message?.content;

                if (content) {
                    // 5. Send Notification with ACTION BUTTONS
                    const { sendFCM } = await import("../_shared/firebase.ts");
                    await sendFCM(conn.fcm_token, mode === "morning_briefing" ? "🌅 Morning Briefing" : "🛡️ Night Watch", content, "PLAN_REQUEST");
                    results.push({ id: conn.id, status: "sent", content });
                }

            } catch (err) {
                console.error(`Error processing connection ${conn.id}`, err);
                results.push({ id: conn.id, status: "error", error: err });
            }
        }

        return new Response(JSON.stringify({ results }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        })

    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
    }
})

// Helper to send FCM

