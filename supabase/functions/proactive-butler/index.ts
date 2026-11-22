import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HAConnection, HAEvent } from '../_shared/types.ts';
import { fetchHAConfig, fetchHAStates } from '../_shared/ha-api.ts';
import { parseJSONResponse, createEmbedding, runProactiveReasoningLoop } from '../_shared/llm-service.ts';
import { runTransitionAgent } from '../_shared/transition-agent.ts';
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from '../_shared/auth.ts';
import { fetchWithTimeout } from '../_shared/model-registry.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SERPER_API_KEY = Deno.env.get("SERPER_API_KEY");

const HABIT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours cooldown per learned habit

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) {
            return new Response(JSON.stringify({ error: auth.error }), {
                status: auth.status || 401,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        const event: HAEvent & { connection_id?: string } = await req.json();
        const payloadConnectionId = event.connection_id;

        // Enforce ownership for non-cron/service callers
        let connectionData: HAConnection | null = null;
        if (payloadConnectionId) {
            const ownership = await verifyConnectionOwnership(supabase, auth, payloadConnectionId);
            if (!ownership.valid) {
                return new Response(JSON.stringify({ error: ownership.error }), {
                    status: ownership.status || 403,
                    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
                });
            }
            connectionData = ownership.connection as HAConnection;
        } else if (!auth.isServiceOrCron) {
            return new Response(JSON.stringify({ error: "connection_id is required" }), {
                status: 400,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        // --- TIER 0 DETERMINISTIC NOISE GATE (€0.00, <1ms) ---
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
            return new Response(JSON.stringify({ result: "ignored", reason: "tier0_telemetry_noise" }), {
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        // --- HISTORY LOGGING (awaited safely so Deno isolate doesn't cancel write) ---
        if (entityId) {
            const { error: histErr } = await supabase.from('device_history').insert({
                connection_id: payloadConnectionId || null,
                entity_id: entityId,
                state: event.state,
                attributes: event.attributes || {}
            });
            if (histErr) console.warn("[ProactiveButler] History log error:", histErr.message);
        }

        const currentHour = new Date().getHours();
        const contextKey = `${entityId}:${event.state}:${currentHour}`;

        // 3-Strikes Suppression Check (strictly tenant-scoped)
        let recentQuery = supabase
            .from('suggestions')
            .select('status')
            .eq('context_key', contextKey)
            .order('created_at', { ascending: false })
            .limit(3);
        if (payloadConnectionId) {
            recentQuery = recentQuery.eq('connection_id', payloadConnectionId);
        }
        const { data: recentSuggestions } = await recentQuery;

        if (recentSuggestions && recentSuggestions.length >= 3) {
            const allRejected = recentSuggestions.every((s: { status: string }) => s.status === 'rejected');
            if (allRejected) {
                console.log(`🚫 Suppressing suggestion for ${contextKey} (3 Strikes Rule)`);
                return new Response(JSON.stringify({ result: "suppressed", reason: "3_strikes" }), {
                    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
                });
            }
        }

        // --- FETCH CONTEXT ---
        let contextDescription = "No external context available.";

        if (connectionData && payloadConnectionId) {
            try {
                // 1. Time Context
                const config = await fetchHAConfig(connectionData);
                let timeContext = new Date().toLocaleString('en-US', { timeZone: 'UTC' }) + " (Server UTC)";
                if (config?.time_zone) {
                    timeContext = new Date().toLocaleString('nl-NL', { timeZone: config.time_zone });
                }

                // 2. States Context
                const allStates = await fetchHAStates(connectionData);

                const weather = allStates.filter((e: any) => e.entity_id?.startsWith('weather.'));
                const people = allStates.filter((e: any) => e.entity_id?.startsWith('person.'));
                const vacuums = allStates.filter((e: any) => e.entity_id?.startsWith('vacuum.'));
                const mediaPlayers = allStates.filter((e: any) => e.entity_id?.startsWith('media_player.'));
                const energy = allStates.filter((e: any) =>
                    e.entity_id?.includes('price') || e.entity_id?.includes('power') ||
                    e.entity_id?.includes('solar') || e.entity_id?.includes('battery') || e.entity_id?.includes('grid')
                );

                contextDescription = `
Current Home Context:
Current Time: ${timeContext}
- Weather: ${weather.map((w: any) => `${w.entity_id}: ${w.state}`).join(', ')}
- People: ${people.map((p: any) => `${p.attributes?.friendly_name || p.entity_id}: ${p.state}`).join(', ')}
- Vacuums: ${vacuums.map((v: any) => `${v.entity_id}: ${v.state} (Bat: ${v.attributes?.battery_level}%)`).join(', ')}
- Music: ${mediaPlayers.map((m: any) => `${m.entity_id}: ${m.state}`).join(', ')}
- Energy: ${energy.slice(0, 10).map((e: any) => `${e.entity_id}: ${e.state}`).join(', ')}
                `.trim();

                // 3. Traffic Scout (properly closed if block!)
                if (event.event_type === "navigation_started" || event.event_type === "traffic_check") {
                    const destination = event.attributes?.destination || "Home";
                    const location = event.attributes?.location || "Current Location";
                    console.log(`🚗 Scouting Traffic: ${location} to ${destination}`);
                    if (SERPER_API_KEY) {
                        const searchRes = await fetchWithTimeout("https://google.serper.dev/search", {
                            method: "POST",
                            headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
                            body: JSON.stringify({ q: `traffic ${location} to ${destination} last hour`, num: 3 })
                        }, 10000);
                        if (searchRes.ok) {
                            const searchData = await searchRes.json();
                            const snippets = searchData.organic?.map((r: any) => r.snippet).join('\n') || "No reports.";
                            contextDescription += `\n\nTRAFFIC CONTEXT:\n${snippets}`;
                        }
                    }
                }

                // 4. Extract Outdoor Temp & Context Snapshot
                const weatherEntity = weather[0];
                const outdoorTemp = weatherEntity?.attributes?.temperature
                    ?? allStates.find((e: any) => e.entity_id?.includes('outdoor') && e.attributes?.unit_of_measurement === '°C')?.state
                    ?? null;
                const parsedTemp = outdoorTemp !== null ? parseFloat(outdoorTemp) : NaN;
                const outdoorTempNum = Number.isFinite(parsedTemp) ? parsedTemp : null;
                const outdoorWeather = weatherEntity?.state || "unknown";
                const primaryPerson = people[0];
                const personState = primaryPerson?.state || event.state || "unknown";

                // Awaited context snapshot insert for pattern mining
                const { error: snapErr } = await supabase.from('context_snapshots').insert({
                    connection_id: payloadConnectionId,
                    entity_id: entityId || 'unknown',
                    service: event.event_type || 'state_changed',
                    service_data: event.attributes || {},
                    outdoor_temp: outdoorTempNum,
                    outdoor_weather: outdoorWeather,
                    presence_state: personState,
                    hour_of_day: currentHour,
                    day_of_week: new Date().getDay()
                });
                if (snapErr) console.warn("[ProactiveButler] Snapshot log error:", snapErr.message);

                // --- AUTONOMOUS BEHAVIOR CORRELATION MATCHING ---
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
                            // Enforce cooldown so the same habit doesn't spam push notifications
                            if (rule.last_triggered_at) {
                                const elapsed = Date.now() - new Date(rule.last_triggered_at).getTime();
                                if (elapsed < HABIT_COOLDOWN_MS) continue;
                            }

                            const triggerMatch = rule.trigger_entity_id === event.entity_id ||
                                rule.trigger_entity_id === event.event_type ||
                                (rule.trigger_entity_id === 'person.*' && event.entity_id?.startsWith('person.')) ||
                                rule.trigger_entity_id === 'any';

                            if (!triggerMatch) continue;

                            if (rule.trigger_state && rule.trigger_state !== 'any' && rule.trigger_state !== event.state) {
                                continue;
                            }

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
                                    domain: rule.action_entity_id?.split('.')[0],
                                    entity_id: rule.action_entity_id,
                                    service: rule.action_service,
                                    data: rule.action_data || {}
                                }];

                                const { error: sugErr } = await supabase.from('suggestions').insert({
                                    connection_id: payloadConnectionId,
                                    title: habitTitle,
                                    description: habitDesc,
                                    actions,
                                    scheduled_actions: [],
                                    status: 'pending',
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

                                await supabase.from('behavior_correlations').update({ last_triggered_at: new Date().toISOString() }).eq('id', rule.id);

                                return new Response(JSON.stringify({
                                    result: "learned_habit_suggested",
                                    rule: rule.title,
                                    confidence: rule.confidence
                                }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
                            }
                        }
                    }
                } catch (corrEvalErr) {
                    console.error("[ProactiveButler] Correlation evaluation error:", corrEvalErr);
                }
            } catch (err) {
                console.error("[ProactiveButler] Failed to fetch HA context:", err);
            }

            // --- TRANSITION AGENT ROUTER ---
            const isTransitionEvent = event.event_type === "navigation_started" ||
                (event.event_type === "state_changed" && event.entity_id && event.entity_id.startsWith("zone."));

            if (isTransitionEvent) {
                console.log("🔀 Routing to Transition Agent...");
                try {
                    const transitionResult = await runTransitionAgent(event, connectionData);

                    if (transitionResult.executed && transitionResult.suggestion) {
                        const sug = transitionResult.suggestion;
                        await supabase.from('suggestions').insert({
                            connection_id: payloadConnectionId,
                            title: sug.title,
                            description: sug.description,
                            actions: sug.actions,
                            scheduled_actions: [],
                            status: 'pending',
                            context_key: contextKey,
                            confidence: 0.95,
                            type: 'transition_hint'
                        });

                        if (connectionData.fcm_token) {
                            const { sendFCM } = await import("../_shared/firebase.ts");
                            await sendFCM(connectionData.fcm_token, transitionResult.push_title!, transitionResult.push_body!);
                        }

                        return new Response(JSON.stringify({ result: "transition_handled" }), {
                            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
                        });
                    } else {
                        return new Response(JSON.stringify({ result: "no_transition_suggestion" }), {
                            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
                        });
                    }
                } catch (err) {
                    console.error("[ProactiveButler] Transition Agent Error:", err);
                }
            }
        }

        // --- FETCH LEARNED CORRELATIONS FOR THE LLM REASONING LOOP ---
        let correlationContext = "";
        if (payloadConnectionId) {
            try {
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
            } catch { /* ignore */ }
        }

        // --- MATCH MEMORIES (Tenant-filtered) ---
        let memoryContext = "";
        try {
            const queryText = `Event: ${event.event_type} ${event.entity_id} ${event.state}. Context: ${contextDescription}`;
            const embedding = await createEmbedding(queryText);
            if (embedding) {
                const { data: memories } = await supabase.rpc('match_memories', {
                    query_embedding: embedding,
                    match_threshold: 0.5,
                    match_count: 5
                });
                const scoped = (memories || []).filter((m: any) => !payloadConnectionId || !m.connection_id || m.connection_id === payloadConnectionId);
                if (scoped.length > 0) {
                    memoryContext = `RELEVANT MEMORIES:\n${scoped.slice(0, 3).map((m: any) => `- "${m.content}"`).join('\n')}`;
                }
            }
        } catch { /* ignore */ }

        // --- PROACTIVE AGENT REASONING LOOP ---
        const systemPrompt = `
You are an intelligent, proactive Home Butler.
Your mission is to autonomously link environmental cues, user routines, and discovered habits to propose ONE helpful action.

REAL-TIME HOME CONTEXT:
${contextDescription}

${correlationContext}

${memoryContext}

INSTRUCTIONS:
1. Observe if current events or context align with known habits or create a genuine comfort/safety opportunity across ANY domain.
2. Propose ONE specific, high-value action (Home Assistant service call) using ONLY real entity_ids from context.
3. Always write "title" and "description" in natural, polite Dutch.
4. Score confidence between 0.0 and 1.0. If the event is trivial or offers no obvious improvement, return "NO_SUGGESTION".

Output Format (JSON):
{
    "title": "Korte Nederlandse titel",
    "description": "Heldere uitleg in het Nederlands over waarom je dit voorstelt",
    "confidence": 0.85,
    "risk": "safe",
    "actions": [
        {
           "type": "call_service",
           "domain": "domain",
           "entity_id": "domain.entity_id",
           "service": "service_name",
           "data": {}
        }
    ]
}
OR "NO_SUGGESTION"
        `.trim();

        const userContent = `Analyze: Event=${event.event_type} Entity=${event.entity_id} State=${event.state} Attr=${JSON.stringify(event.attributes || {})}`;

        const { content, provider, model } = await runProactiveReasoningLoop([
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
        ], 450);

        console.log(`[ProactiveButler] LLM reasoning completed using ${provider} (${model})`);
        const suggestion = parseJSONResponse(content);

        if (!suggestion || content.includes("NO_SUGGESTION")) {
            return new Response(JSON.stringify({ result: "no_suggestion" }), {
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        const confidence = suggestion.confidence || 0.5;
        if (confidence < 0.6) {
            return new Response(JSON.stringify({ result: "suppressed", reason: "low_confidence" }), {
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        const { error } = await supabase.from('suggestions').insert({
            connection_id: payloadConnectionId || null,
            title: suggestion.title,
            description: suggestion.description,
            actions: suggestion.actions,
            scheduled_actions: suggestion.scheduled_actions || [],
            status: 'pending',
            context_key: contextKey,
            confidence
        });
        if (error) throw error;

        let pushResult = "no_token";
        if (connectionData?.fcm_token) {
            const { sendFCM } = await import("../_shared/firebase.ts");
            await sendFCM(connectionData.fcm_token, suggestion.title, suggestion.description);
            pushResult = "sent";
        }

        return new Response(JSON.stringify({
            result: "suggestion_created",
            suggestion,
            push: pushResult,
            auto_executed: false
        }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    } catch (err: any) {
        console.error("[ProactiveButler] Error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }
});
