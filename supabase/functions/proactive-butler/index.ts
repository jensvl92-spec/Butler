// @ts-ignore
import { createClient } from "npm:@supabase/supabase-js@2.38.4"
import { AIAction, HAConnection, HAEvent } from '../_shared/types.ts'
import { fetchHAConfig, fetchHAStates, callHAService, createHAAutomation } from '../_shared/ha-api.ts'
import { chatCompletion, parseJSONResponse, createEmbedding, runProactiveReasoningLoop } from '../_shared/llm-service.ts'
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
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

        // --- TIER 0 DETERMINISTIC NOISE GATE (€0.00, <1ms) ---
        // Smart homes generate thousands of noisy telemetry events daily (e.g. power meters fluctuating 2W, CPU % jitter).
        // Discard high-frequency noise immediately to prevent unnecessary HA state downloads, vector embeddings, and LLM costs.
        const entityId = event.entity_id || '';
        const eventType = event.event_type || '';
        const unit = (event.attributes?.unit_of_measurement || '').toLowerCase();
        
        const isTelemetryNoise = 
            ['w', 'kw', 'kwh', 'v', 'a', 'hz', 'db', 'ppm', 'b', 'kb', 'mb', 'ms', 's', '%'].includes(unit) ||
            entityId.includes('power') || 
            entityId.includes('voltage') || 
            entityId.includes('current') || 
            entityId.includes('frequency') ||
            entityId.startsWith('update.') ||
            entityId.startsWith('button.');

        const isActionableTrigger = 
            eventType === 'navigation_started' ||
            eventType === 'traffic_check' ||
            entityId.startsWith('person.') ||
            entityId.startsWith('device_tracker.') ||
            entityId.startsWith('zone.') ||
            entityId === 'sun.sun' ||
            entityId.startsWith('weather.') ||
            entityId.startsWith('lock.') ||
            entityId.startsWith('alarm_control_panel.') ||
            entityId.startsWith('cover.') ||
            entityId.startsWith('binary_sensor.') ||
            entityId.startsWith('climate.') ||
            entityId.startsWith('media_player.');

        if (isTelemetryNoise && !isActionableTrigger) {
            console.log(`🔇 [Tier 0 Gate] Dropped telemetry noise: ${entityId} (${event.state} ${unit})`);
            return new Response(JSON.stringify({ result: "ignored", reason: "tier0_telemetry_noise" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

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
                    // 4. Extract Outdoor Temp & Context Snapshot
                    const weatherEntity = weather[0];
                    const outdoorTemp = weatherEntity?.attributes?.temperature
                        ?? allStates.find((e: any) => e.entity_id.includes('outdoor') && e.attributes?.unit_of_measurement === '°C')?.state
                        ?? null;
                    const outdoorTempNum = outdoorTemp !== null ? parseFloat(outdoorTemp) : null;
                    const outdoorWeather = weatherEntity?.state || "unknown";
                    const primaryPerson = people[0];
                    const personState = primaryPerson?.state || event.state || "unknown";

                    // Fire-and-forget context snapshot logging for future pattern mining
                    try {
                        supabase.from('context_snapshots').insert({
                            connection_id: payloadConnectionId,
                            entity_id: event.entity_id || 'unknown',
                            service: event.event_type || 'state_changed',
                            service_data: event.attributes || {},
                            outdoor_temp: outdoorTempNum,
                            outdoor_weather: outdoorWeather,
                            presence_state: personState,
                            hour_of_day: currentHour,
                            day_of_week: new Date().getDay()
                        }).then(({ error }: any) => { if (error) console.error("Snapshot Log Error", error) });
                    } catch (e) { /* ignore */ }

                    // --- AUTONOMOUS BEHAVIOR CORRELATION MATCHING ---
                    // Dynamically matches learned habits across ALL domains (climate, lights, covers, media, etc.)
                    try {
                        const { data: correlations } = await supabase
                            .from('behavior_correlations')
                            .select('*')
                            .eq('connection_id', payloadConnectionId)
                            .eq('suppressed', false)
                            .gte('confidence', 0.65)
                            .order('confidence', { ascending: false });

                        if (correlations && correlations.length > 0) {
                            for (const rule of correlations) {
                                // Match trigger entity
                                const triggerMatch = rule.trigger_entity_id === event.entity_id ||
                                    rule.trigger_entity_id === event.event_type ||
                                    (rule.trigger_entity_id === 'person.*' && event.entity_id?.startsWith('person.')) ||
                                    rule.trigger_entity_id === 'any';

                                if (!triggerMatch) continue;

                                // Match trigger state if specified
                                if (rule.trigger_state && rule.trigger_state !== 'any' && rule.trigger_state !== event.state) {
                                    continue;
                                }

                                // Dynamic condition evaluation across any environmental variable
                                let conditionsMet = true;
                                if (rule.conditions) {
                                    for (const [key, val] of Object.entries(rule.conditions)) {
                                        if (key === 'outdoor_temp_lte' && (outdoorTempNum === null || outdoorTempNum > (val as number))) conditionsMet = false;
                                        if (key === 'outdoor_temp_gte' && (outdoorTempNum === null || outdoorTempNum < (val as number))) conditionsMet = false;
                                        if (key === 'outdoor_weather' && outdoorWeather !== val) conditionsMet = false;
                                        if (key === 'presence' && personState !== val) conditionsMet = false;
                                    }
                                }

                                if (conditionsMet) {
                                    console.log(`🎯 Autonomous Habit Matched: ${rule.title} (Confidence: ${rule.confidence})`);
                                    const habitTitle = rule.title;
                                    const habitDesc = rule.description || `${rule.title}. Zal ik dit voor je uitvoeren?`;

                                    const actions = [{
                                        type: "call_service",
                                        entity_id: rule.action_entity_id,
                                        service: rule.action_service,
                                        data: rule.action_data || {}
                                    }];

                                    // Store proactive suggestion pending user confirmation
                                    const { error: sugErr } = await supabase.from('suggestions').insert({
                                        connection_id: payloadConnectionId,
                                        title: habitTitle,
                                        description: habitDesc,
                                        actions: actions,
                                        scheduled_actions: [],
                                        status: 'pending', // Requires user verification
                                        context_key: contextKey,
                                        confidence: rule.confidence,
                                        type: 'learned_habit'
                                    });

                                    if (!sugErr && connectionData.fcm_token) {
                                        const { sendFCM } = await import("../_shared/firebase.ts");
                                        await sendFCM(
                                            connectionData.fcm_token,
                                            habitTitle,
                                            habitDesc,
                                            'PROACTIVE_HABIT',
                                            { action_entity: rule.action_entity_id }
                                        );
                                    }

                                    // Update last_triggered_at
                                    await supabase.from('behavior_correlations').update({ last_triggered_at: new Date().toISOString() }).eq('id', rule.id);

                                    return new Response(JSON.stringify({
                                        result: "learned_habit_suggested",
                                        rule: rule.title,
                                        confidence: rule.confidence
                                    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                                }
                            }
                        }
                    } catch (corrEvalErr) {
                        console.error("[ProactiveButler] Correlation evaluation error:", corrEvalErr);
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

        // --- FETCH LEARNED CORRELATIONS FOR THE LLM REASONING LOOP ---
        let correlationContext = "";
        try {
            if (payloadConnectionId) {
                const { data: activeCorrelations } = await supabase
                    .from('behavior_correlations')
                    .select('title, description, trigger_entity_id, trigger_state, conditions, action_entity_id, action_service, action_data, confidence')
                    .eq('connection_id', payloadConnectionId)
                    .eq('suppressed', false)
                    .gte('confidence', 0.65)
                    .limit(10);

                if (activeCorrelations && activeCorrelations.length > 0) {
                    correlationContext = `KNOWN HABITS & CORRELATIONS (Autonomous memory):\n` +
                        activeCorrelations.map((c: any) => `- [${c.title}]: When ${c.trigger_entity_id} (${c.trigger_state}) with ${JSON.stringify(c.conditions)} -> user usually sets ${c.action_entity_id}.${c.action_service} (${Math.round(c.confidence * 100)}% confidence). Habit: "${c.description}"`).join('\n');
                }
            }
        } catch (e) { /* ignore */ }

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

        // --- PROACTIVE AGENT REASONING LOOP ---
        const systemPrompt = `
        You are an intelligent, proactive Home Butler (Level 5 Autonomy).
        Your mission is to autonomously link environmental cues, user routines, and discovered habits to propose ONE helpful action.

        REAL-TIME HOME CONTEXT:
        ${contextDescription}

        ${correlationContext}

        ${memoryContext}
        
        INSTRUCTIONS:
        1. Independently draw conclusions: Observe if current events or context (e.g. resident arriving/leaving, cold/hot weather, sunset, rain, morning routines) align with known habits or create a genuine comfort/safety opportunity across ANY domain (climate, lights, covers, appliances, media, switches, locks, etc.).
        2. Propose ONE specific, high-value action (Home Assistant service call).
        3. Never assume hardcoded rules: deduce what makes sense from the actual state and context.
        4. Always write "title" and "description" in natural, polite Dutch. Explain your reasoning clearly to the user.
        5. Score confidence between 0.0 and 1.0. If the event is trivial or offers no obvious improvement, return "NO_SUGGESTION".

        Output Format (JSON):
        {
            "title": "Korte Nederlandse titel",
            "description": "Heldere uitleg in het Nederlands over waarom je dit voorstelt",
            "confidence": 0.85,
            "risk": "safe",
            "actions": [
                {
                   "type": "call_service",
                   "entity_id": "domain.entity_id",
                   "service": "service_name",
                   "data": {}
                }
            ]
        }
        OR "NO_SUGGESTION"
        `;

        const userContent = `Analyze: Event=${event.event_type} Entity=${event.entity_id} State=${event.state} Attr=${JSON.stringify(event.attributes)}`;

        const { content, provider, model } = await runProactiveReasoningLoop([{ role: "system", content: systemPrompt }, { role: "user", content: userContent }], 400);
        console.log(`[ProactiveButler] LLM reasoning completed using ${provider} (${model})`);
        const suggestion = parseJSONResponse(content);

        if (!suggestion || content.includes("NO_SUGGESTION")) {
            return new Response(JSON.stringify({ result: "no_suggestion" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
        }

        // --- PROPOSAL VERIFICATION MATRIX ---
        const confidence = suggestion.confidence || 0.5;
        let status = "pending"; // Proactive actions always require user verification first
        let pushTitle = suggestion.title;
        let pushBody = suggestion.description;

        if (confidence < 0.6) {
            return new Response(JSON.stringify({ result: "suppressed", reason: "low_confidence" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
        }

        // --- SAVE SUGGESTION ---
        const { error } = await supabase.from('suggestions').insert({
            connection_id: payloadConnectionId || null,
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

        return new Response(JSON.stringify({ result: "suggestion_created", suggestion, push: pushResult, auto_executed: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })

    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }
})
