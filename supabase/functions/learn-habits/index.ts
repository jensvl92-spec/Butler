/**
 * Learn Habits - Predictive action & multi-variable correlation learning system
 * Endpoints: POST /learn, GET/POST /predict, POST /suppress
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { chatCompletion, parseJSONResponse } from '../_shared/llm-service.ts';
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from '../_shared/auth.ts';
import { fetchHAStates } from '../_shared/ha-api.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MIN_OCCURRENCES = 3;

interface ActionPattern {
    entity_id: string;
    service: string;
    day_of_week: number | null;
    hour: number;
    count: number;
}

function jsonResponse(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/learn-habits/, '') || '/learn';

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

        // =============================================
        // POST /learn (or /) - Analyze chat history & context snapshots
        // =============================================
        if ((path === '/learn' || path === '/') && req.method === 'POST') {
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

            const { data: chats, error: chatError } = await supabase
                .from('chat_history')
                .select('actions_taken, created_at')
                .eq('connection_id', connectionId)
                .gte('created_at', thirtyDaysAgo)
                .not('actions_taken', 'is', null);

            if (chatError) throw chatError;

            // === 1. Extract Chat Patterns (Time-based routines) ===
            const patternMap = new Map<string, ActionPattern>();
            for (const chat of (chats || [])) {
                const actions = Array.isArray(chat.actions_taken) ? chat.actions_taken : [];
                const timestamp = new Date(chat.created_at);
                const hour = timestamp.getHours();
                const dayOfWeek = timestamp.getDay();

                for (const action of actions) {
                    if (!action?.entity_id || !action?.service) continue;
                    const key = `${action.entity_id}|${action.service}|${hour}|${dayOfWeek}`;
                    if (patternMap.has(key)) {
                        patternMap.get(key)!.count++;
                    } else {
                        patternMap.set(key, {
                            entity_id: action.entity_id,
                            service: action.service,
                            day_of_week: dayOfWeek,
                            hour,
                            count: 1
                        });
                    }
                }
            }

            const significantPatterns = Array.from(patternMap.values()).filter(p => p.count >= MIN_OCCURRENCES);

            for (const pattern of significantPatterns) {
                const confidence = Math.min(1.0, pattern.count / 10);
                await supabase.from('behavior_patterns').upsert({
                    connection_id: connectionId,
                    entity_id: pattern.entity_id,
                    service: pattern.service,
                    day_of_week: pattern.day_of_week,
                    hour: pattern.hour,
                    occurrence_count: pattern.count,
                    confidence,
                    last_occurred: new Date().toISOString()
                }, { onConflict: 'connection_id,entity_id,service,day_of_week,hour' });
            }

            // === 2. Autonomous Multi-Variable Context Correlation Mining (ALWAYS runs even if chat_history is empty!) ===
            let correlationsFound = 0;

            try {
                const { data: snapshots } = await supabase
                    .from('context_snapshots')
                    .select('*')
                    .eq('connection_id', connectionId)
                    .gte('created_at', thirtyDaysAgo)
                    .order('created_at', { ascending: true })
                    .limit(150);

                if (snapshots && snapshots.length >= 3) {
                    const traceLines = snapshots.map((s: any) => {
                        const ts = new Date(s.created_at).toISOString().substring(11, 16);
                        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.day_of_week ?? 0];
                        const weatherInfo = s.outdoor_temp !== null ? `outdoor:${s.outdoor_temp}°C/${s.outdoor_weather}` : '';
                        const presenceInfo = s.presence_state ? `presence:${s.presence_state}` : '';
                        const sData = s.service_data && Object.keys(s.service_data).length > 0 ? JSON.stringify(s.service_data) : '';
                        return `${day} ${ts} | entity:${s.entity_id} | action:${s.service} ${sData} | ${presenceInfo} ${weatherInfo}`.trim();
                    }).join('\n');

                    const MINER_PROMPT = `You are the Butler Autonomous Correlation Engine.
Analyze the smart home event trace and discover RECURRING CAUSAL ASSOCIATIONS across ANY DOMAIN (climate, lights, covers, switches, media, presence, vacuum, locks, etc.).

INSTRUCTIONS:
1. Find ONLY real patterns backed by the trace data. Do not invent entities.
2. Output all titles and descriptions in natural, friendly Dutch.
3. Return valid JSON ONLY:
{
  "correlations": [
    {
      "title": "Korte Nederlandse titel",
      "description": "Uitleg in het Nederlands over de ontdekte gewoonte",
      "trigger_entity_id": "entity of trigger",
      "trigger_state": "trigger status or event",
      "conditions": {},
      "action_entity_id": "target entity id",
      "action_service": "service to call",
      "action_data": {},
      "confidence": 0.85,
      "occurrence_count": 3
    }
  ]
}
If no reliable pattern is found, return { "correlations": [] }.`;

                    const llmResponse = await chatCompletion(
                        [
                            { role: 'system', content: MINER_PROMPT },
                            { role: 'user', content: `TRACE DATA:\n${traceLines}` }
                        ],
                        4000,
                        0.2,
                        undefined,
                        undefined,
                        undefined,
                        { effort: 'high' },
                        'deep_reasoning'
                    );

                    const parsed = parseJSONResponse(llmResponse);
                    const rules = parsed?.correlations || [];

                    for (const rule of rules) {
                        if (!rule.trigger_entity_id || !rule.action_entity_id || !rule.action_service) continue;

                        await supabase.from('behavior_correlations').upsert({
                            connection_id: connectionId,
                            title: rule.title || 'Geleerde gewoonte',
                            description: rule.description || '',
                            trigger_entity_id: rule.trigger_entity_id,
                            trigger_state: rule.trigger_state || 'any',
                            conditions: rule.conditions || {},
                            action_entity_id: rule.action_entity_id,
                            action_service: rule.action_service,
                            action_data: rule.action_data || {},
                            occurrence_count: rule.occurrence_count || 3,
                            confidence: Math.min(1.0, Math.max(0.6, rule.confidence || 0.75)),
                            auto_executable: false,
                            updated_at: new Date().toISOString()
                        }, { onConflict: 'connection_id,trigger_entity_id,trigger_state,action_entity_id,action_service' });

                        correlationsFound++;
                    }
                }
            } catch (corrErr) {
                console.error('[Habits] Autonomous correlation mining error:', corrErr);
            }

            return jsonResponse({
                success: true,
                analyzed_chats: (chats || []).length,
                patterns_found: significantPatterns.length,
                correlations_found: correlationsFound,
                message: `Analyse voltooid: ${significantPatterns.length} tijdpatronen en ${correlationsFound} correlaties ontdekt.`,
                patterns: significantPatterns.slice(0, 10).map(p => ({
                    entity: p.entity_id,
                    action: p.service,
                    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][p.day_of_week!],
                    hour: `${p.hour}:00`,
                    count: p.count
                }))
            });
        }

        // =============================================
        // GET/POST /predict - Get predictions for current time (midnight-wrap safe)
        // =============================================
        if (path === '/predict') {
            const now = new Date();
            const currentHour = now.getHours();
            const currentDay = now.getDay();
            const windowHours = [(currentHour + 23) % 24, currentHour, (currentHour + 1) % 24];

            const { data: patterns } = await supabase
                .from('behavior_patterns')
                .select('*')
                .eq('connection_id', connectionId)
                .eq('suppressed', false)
                .gte('occurrence_count', MIN_OCCURRENCES)
                .or(`day_of_week.eq.${currentDay},day_of_week.is.null`)
                .in('hour', windowHours)
                .order('confidence', { ascending: false })
                .limit(5);

            if (!patterns || patterns.length === 0) {
                return jsonResponse({
                    success: true,
                    predictions: [],
                    message: 'Geen gewoonte-voorspellingen voor dit tijdstip.'
                });
            }

            let friendlyNames: Record<string, string> = {};
            try {
                const states = await fetchHAStates(conn);
                friendlyNames = Object.fromEntries(
                    states.map((s: any) => [s.entity_id, s.attributes?.friendly_name || s.entity_id])
                );
            } catch (e) {
                console.error('[Habits] Failed to fetch states:', e);
            }

            const predictions = patterns.map((p: any) => ({
                pattern_id: p.id,
                entity_id: p.entity_id,
                friendly_name: friendlyNames[p.entity_id] || p.entity_id,
                service: p.service,
                confidence: Math.round(p.confidence * 100),
                occurrences: p.occurrence_count,
                suggestion: `Je doet meestal ${p.service.replace('.', ' ')} op ${friendlyNames[p.entity_id] || p.entity_id} rond ${p.hour}:00. Zal ik dit uitvoeren?`
            }));

            return jsonResponse({
                success: true,
                current_time: `${currentHour}:00`,
                current_day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][currentDay],
                predictions
            });
        }

        // =============================================
        // POST /suppress - Stop suggesting a pattern
        // =============================================
        if (path === '/suppress' && req.method === 'POST') {
            const patternId = body.pattern_id;
            if (!patternId) return jsonResponse({ error: 'pattern_id required' }, 400);

            const { error } = await supabase
                .from('behavior_patterns')
                .update({ suppressed: true })
                .eq('id', patternId)
                .eq('connection_id', connectionId);

            if (error) throw error;
            return jsonResponse({ success: true, message: 'Patroon onderdrukt.' });
        }

        return jsonResponse({ error: 'Endpoint not found', path }, 404);

    } catch (err: any) {
        console.error('[Habits] Error:', err);
        return jsonResponse({ error: err.message }, 500);
    }
});
