// @ts-ignore
import { createClient } from "npm:@supabase/supabase-js@2.38.4"
import { AIAction, HAConnection, HAEvent } from '../_shared/types.ts'
import { fetchHAConfig, fetchHAStates, callHAService, createHAAutomation } from '../_shared/ha-api.ts'
import { chatCompletion, parseJSONResponse, createEmbedding } from '../_shared/llm-service.ts'
import { executeActionMatrix } from '../_shared/action-executor.ts'
import { runTransitionAgent } from '../_shared/transition-agent.ts'

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

// @ts-ignore
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
// @ts-ignore
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
// @ts-ignore
const SERPER_API_KEY = Deno.env.get("SERPER_API_KEY");

// 3. System Prompt for the 'Butler'
const BUTLER_PROMPT = `
You are an intelligent, proactive Home Butler.
You receive a "Life Event" from the user's home (e.g., arrived home, sunset, waking up).
Your goal is to suggest ONE helpful action to improve the user's comfort or safety.

Rules:
1. If the event is trivial or offers no obvious improvement, return NULL (empty JSON).
2. Do not suggest things that are likely already automated.
3. Be concise and polite.
4. Output specific Home Assistant actions (service calls).

Response Format (JSON):
{
  "title": "Short title (e.g. Turn on lights)",
  "description": "Reasoning (e.g. It is dark outside and you just arrived.)",
  "actions": [
    {
       "type": "call_service",
       "entity_id": "domain.entity",
       "service": "turn_on",
       "data": {}
    }
  ],
  "scheduled_actions": [
    {
      "title": "Turn OFF in 10 mins",
      "delay_seconds": 600,
      "actions": [...]
    }
  ]
}
OR null if no suggestion.
`;

// @ts-ignore
Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

    try {
        const event: HAEvent = await req.json()
        console.log("🔔 Received Event:", event)
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

        // --- HISTORY LOGGING (For Planner Agent) ---
        // Fire-and-forget insert to keep latency low
        try {
            supabase.from('device_history').insert({
                entity_id: event.entity_id,
                state: event.state,
                attributes: event.attributes
            }).then(({ error }) => { if (error) console.error("History Log Error", error) });
        } catch (e) { /* ignore */ }

        const currentHour = new Date().getHours()
        const contextKey = `${event.entity_id}:${event.state}:${currentHour}`
        // Removed duplicate supabase declaration here

        const { data: recentSuggestions } = await supabase.from('suggestions').select('status').eq('context_key', contextKey).order('created_at', { ascending: false }).limit(3)
        if (recentSuggestions && recentSuggestions.length >= 3) {
            const allRejected = recentSuggestions.every((s: { status: string }) => s.status === 'rejected')
            if (allRejected) {
                console.log(`🚫 Suppressing suggestion for ${contextKey} (3 Strikes Rule)`)
                return new Response(JSON.stringify({ result: "suppressed", reason: "3_strikes" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
            }
        }

        // --- FETCH CONTEXT ---
        let contextDescription = "No external context available.";
        let connectionData: HAConnection | null = null;
        // @ts-ignore
        const payloadConnectionId = event.connection_id;

        if (payloadConnectionId) {
            const { data: conn, error: connError } = await supabase.from('ha_connections').select('id, api_url, api_token, fcm_token').eq('id', payloadConnectionId).single();

            if (!connError && conn) {
                // Fix URL
                try {
                    const urlObj = new URL(conn.api_url)
                    conn.api_url = urlObj.origin
                } catch (e) { /* ignore */ }

                connectionData = conn as HAConnection;

                try {
                    // 1. Time Context
                    const config = await fetchHAConfig(connectionData);
                    let timeContext = new Date().toLocaleString('en-US', { timeZone: 'UTC' }) + " (Server UTC)";
                    if (config?.time_zone) timeContext = new Date().toLocaleString('en-US', { timeZone: config.time_zone });

                    // 2. States Context
                    const allStates = await fetchHAStates(connectionData);

                    const weather = allStates.filter((e: any) => e.entity_id.startsWith('weather.'));
                    const people = allStates.filter((e: any) => e.entity_id.startsWith('person.'));
                    const vacuums = allStates.filter((e: any) => e.entity_id.startsWith('vacuum.'));
                    const mediaPlayers = allStates.filter((e: any) => e.entity_id.startsWith('media_player.'));
                    const energy = allStates.filter((e: any) => e.entity_id.includes('price') || e.entity_id.includes('power') || e.entity_id.includes('solar') || e.entity_id.includes('battery') || e.entity_id.includes('grid'));

                    contextDescription = `
                    Current Home Context:
                    Current Time: ${timeContext}
                    - Weather: ${weather.map((w: any) => `${w.entity_id}: ${w.state}`).join(', ')}
                    - People: ${people.map((p: any) => `${p.attributes.friendly_name}: ${p.state}`).join(', ')}
                    - Vacuums: ${vacuums.map((v: any) => `${v.entity_id}: ${v.state} (Bat: ${v.attributes?.battery_level}%)`).join(', ')}
                    - Music: ${mediaPlayers.map((m: any) => `${m.entity_id}: ${m.state}`).join(', ')}
                    - Energy: ${energy.slice(0, 10).map((e: any) => `${e.entity_id}: ${e.state}`).join(', ')}
                    `;

                    // 3. Traffic Scout
                    if (event.event_type === "navigation_started" || event.event_type === "traffic_check") {
                        const destination = event.attributes?.destination || "Home";
                        const location = event.attributes?.location || "Current Location";
                        console.log(`🚗 Scouting Traffic: ${location} to ${destination}`);
                        if (SERPER_API_KEY) {
                            const searchRes = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ q: `traffic ${location} to ${destination} last hour`, num: 3 }) });
                            if (searchRes.ok) {
                                const searchData = await searchRes.json();
                                const snippets = searchData.organic?.map((r: any) => r.snippet).join('\n') || "No reports.";
                                contextDescription += `\n\nTRAFFIC CONTEXT:\n${snippets}`;
                            }
                        }
                    }
                } catch (err) { console.error("Failed to fetch HA context", err); }

                // --- TRANSITION AGENT ROUTER ---
                // "Welcome Home" Logic for Navigation / Zone Changes
                const isTransitionEvent = event.event_type === "navigation_started" ||
                    (event.event_type === "state_changed" && event.entity_id && event.entity_id.startsWith("zone."));

                if (isTransitionEvent) {
                    console.log("🔀 Routing to Transition Agent...");
                    try {
                        const transitionResult = await runTransitionAgent(event, connectionData);

                        if (transitionResult.executed && transitionResult.suggestion) {
                            // Save & Push
                            const sug = transitionResult.suggestion;
                            const { error } = await supabase.from('suggestions').insert({
                                title: sug.title,
                                description: sug.description,
                                actions: sug.actions,
                                scheduled_actions: [],
                                status: 'pending', // Always pending for now (Testing Phase)
                                context_key: contextKey,
                                confidence: 0.95,
                                type: 'transition_hint' // Mark for future analysis
                            });

                            if (connectionData.fcm_token) {
                                const { sendFCM } = await import("../_shared/firebase.ts");
                                await sendFCM(connectionData.fcm_token, transitionResult.push_title!, transitionResult.push_body!);
                            }

                            return new Response(JSON.stringify({ result: "transition_handled" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                        } else {
                            // If Agent returns "NO_SUGGESTION", we can either fall back to generic or just exit.
                            // Given this is specialized, we probably exit to avoid noise.
                            console.log("Transition Agent had no suggestions.");
                            return new Response(JSON.stringify({ result: "no_transition_suggestion" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                        }
                    } catch (err) { console.error("Transition Agent Error", err); }
                }
            }
        }

        // --- MATCH MEMORIES ---
        let memoryContext = "";
        try {
            const queryText = `Event: ${event.event_type} ${event.entity_id} ${event.state}. Context: ${contextDescription}`;
            const embedding = await createEmbedding(queryText);
            if (embedding) {
                const { data: memories } = await supabase.rpc('match_memories', { query_embedding: embedding, match_threshold: 0.5, match_count: 3 });
                if (memories && memories.length > 0) memoryContext = `RELEVANT MEMORIES:\n${memories.map((m: any) => `- "${m.content}"`).join('\n')}`;
            }
        } catch (e) { /* ignore */ }

        // --- LLM ANALYSIS ---
        const systemPrompt = `
        You are an intelligent, proactive Home Butler (Level 5 Autonomy).
        GOAL: Suggest ONE helpful action.

        ADDITIONAL CONTEXT:
        ${contextDescription}

        ${memoryContext}
        
        INSTRUCTIONS:
        1. Energy Strategy (Critical): "Surplus Mode" (Charge/Run if Solar High), "Arbitrage" (Discharge if Price High).
        2. Safety: Don't run loud things if empty.
        3. Confidence Scoring (0.0 - 1.0).

        Output Format (JSON):
        {
            "title": "Suggestion Title",
            "description": "Reasoning...",
            "confidence": 0.95,
            "risk": "safe",
            "actions": [...]
        }
        OR "NO_SUGGESTION"
        `;

        const userContent = `Analyze: Event=${event.event_type} Entity=${event.entity_id} State=${event.state} Attr=${JSON.stringify(event.attributes)}`;

        const content = await chatCompletion([{ role: "system", content: systemPrompt }, { role: "user", content: userContent }], 250);
        const suggestion = parseJSONResponse(content);

        if (!suggestion || content.includes("NO_SUGGESTION")) {
            return new Response(JSON.stringify({ result: "no_suggestion" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
        }

        // --- EXECUTION MATRIX ---
        const confidence = suggestion.confidence || 0.5;
        const risk = suggestion.risk || "risky";
        let status = "pending";
        let pushTitle = suggestion.title;
        let pushBody = suggestion.description;
        let autoExecuted = false;

        if (confidence < 0.6) {
            return new Response(JSON.stringify({ result: "suppressed", reason: "low_confidence" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
        }

        const isAutomation = suggestion.actions?.some((a: any) => a.type === 'create_automation' || a.service?.includes('automation'));
        const isPurchase = suggestion.title.toLowerCase().match(/buy|shop|purchase|order|pay/);

        if (isAutomation || isPurchase) {
            status = "pending";
        } else if (confidence >= 0.9 && risk === "safe" && connectionData) {
            try {
                console.log(`⚡ Auto-Executing: ${suggestion.title}`);
                await executeActionMatrix(suggestion.actions, connectionData, supabase);
                status = "executed";
                autoExecuted = true;
                pushTitle = `✨ Butler Acted: ${suggestion.title}`;
                pushBody = `Confidence ${confidence * 100}%. Executed. Tap to undo.`;
            } catch (err) { status = "failed_auto"; }
        }

        // --- SAVE SUGGESTION ---
        const { error } = await supabase.from('suggestions').insert({
            title: suggestion.title,
            description: suggestion.description,
            actions: suggestion.actions,
            scheduled_actions: suggestion.scheduled_actions || [],
            status: status,
            context_key: contextKey,
            confidence: confidence
        })
        if (error) throw error

        let pushResult = "no_token";
        if (connectionData?.fcm_token) {
            const { sendFCM } = await import("../_shared/firebase.ts");
            await sendFCM(connectionData.fcm_token, pushTitle, pushBody);
            pushResult = "sent";
        }

        return new Response(JSON.stringify({ result: "suggestion_created", suggestion, push: pushResult, auto_executed: autoExecuted }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })

    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }
})
