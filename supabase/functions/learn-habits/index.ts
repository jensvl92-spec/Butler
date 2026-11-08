/**
 * Learn Habits - Predictive action learning system
 * 
 * Analyzes chat history to find recurring action patterns.
 * Stores patterns in behavior_patterns table.
 * 
 * Endpoints:
 * - POST /learn    - Analyze history and update patterns
 * - GET  /predict  - Get predictions for current time
 * - POST /suppress - Stop suggesting a specific pattern
 * 
 * Run weekly via pg_cron
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2.38.4"
import { chatCompletion, parseJSONResponse } from '../_shared/llm-service.ts'

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

// Minimum occurrences to become a pattern
const MIN_OCCURRENCES = 3;
// Time window for matching (±15 minutes)
const TIME_WINDOW_MINUTES = 15;

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
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/learn-habits/, '') || '/';

    try {
        const body = req.method === 'POST' ? await req.json() : {};
        const connectionId = url.searchParams.get('connection_id') || body.connection_id;

        if (!connectionId) {
            return jsonResponse({ error: 'connection_id required' }, 400);
        }

        // =============================================
        // POST /learn - Analyze chat history for patterns
        // =============================================
        if (path === '/learn' && req.method === 'POST') {
            console.log(`[Habits] Learning patterns for connection ${connectionId}`);

            // Fetch chat history from last 30 days
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

            const { data: chats, error: chatError } = await supabase
                .from('chat_history')
                .select('actions_taken, created_at')
                .eq('connection_id', connectionId)
                .gte('created_at', thirtyDaysAgo)
                .not('actions_taken', 'is', null);

            if (chatError) throw chatError;

            if (!chats || chats.length === 0) {
                return jsonResponse({
                    success: true,
                    message: 'No chat history found',
                    patterns: 0
                });
            }

            // === 1. Extract Chat Patterns (Time-based routines) ===
            const patternMap = new Map<string, ActionPattern>();

            for (const chat of chats) {
                const actions = chat.actions_taken || [];
                const timestamp = new Date(chat.created_at);
                const hour = timestamp.getHours();
                const dayOfWeek = timestamp.getDay();

                for (const action of actions) {
                    if (!action.entity_id || !action.service) continue;

                    // Key: entity|service|hour|day
                    const key = `${action.entity_id}|${action.service}|${hour}|${dayOfWeek}`;

                    if (patternMap.has(key)) {
                        patternMap.get(key)!.count++;
                    } else {
                        patternMap.set(key, {
                            entity_id: action.entity_id,
                            service: action.service,
                            day_of_week: dayOfWeek,
                            hour: hour,
                            count: 1
                        });
                    }
                }
            }

            // Filter to patterns with minimum occurrences
            const significantPatterns = Array.from(patternMap.values())
                .filter(p => p.count >= MIN_OCCURRENCES);

            console.log(`[Habits] Found ${significantPatterns.length} significant time patterns`);

            // Upsert time patterns
            let upserted = 0;
            for (const pattern of significantPatterns) {
                const confidence = Math.min(1.0, pattern.count / 10);

                await supabase.from('behavior_patterns').upsert({
                    connection_id: connectionId,
                    entity_id: pattern.entity_id,
                    service: pattern.service,
                    day_of_week: pattern.day_of_week,
                    hour: pattern.hour,
                    occurrence_count: pattern.count,
                    confidence: confidence,
                    last_occurred: new Date().toISOString()
                }, { onConflict: 'connection_id, entity_id, service, day_of_week, hour' });

                upserted++;
            }

            // === 2. Autonomous Multi-Variable Context Correlation Mining (LLM Loop) ===
            // The LLM on its own analyzes chronological traces across ALL domains (climate, lights, covers, appliances, etc.)
            let correlationsFound = 0;
            const discoveredRules: any[] = [];

            try {
                const { data: snapshots } = await supabase
                    .from('context_snapshots')
                    .select('*')
                    .eq('connection_id', connectionId)
                    .gte('created_at', thirtyDaysAgo)
                    .order('created_at', { ascending: true })
                    .limit(150);

                if (snapshots && snapshots.length >= 3) {
                    // Build a compact, chronological trace of events and context for the LLM
                    const traceLines = snapshots.map((s: any) => {
                        const ts = new Date(s.created_at).toISOString().substring(11, 16);
                        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.day_of_week];
                        const weatherInfo = s.outdoor_temp !== null ? `outdoor:${s.outdoor_temp}°C/${s.outdoor_weather}` : '';
                        const presenceInfo = s.presence_state ? `presence:${s.presence_state}` : '';
                        const sData = s.service_data && Object.keys(s.service_data).length > 0 ? JSON.stringify(s.service_data) : '';
                        return `${day} ${ts} | entity:${s.entity_id} | action:${s.service} ${sData} | ${presenceInfo} ${weatherInfo}`.trim();
                    }).join('\n');

                    const MINER_PROMPT = `
You are the Butler Autonomous Correlation Engine (Level 5 Autonomy).
Your task is to analyze the smart home event trace and discover RECURRING CAUSAL ASSOCIATIONS across ANY DOMAIN (climate, lights, covers, switches, media, presence, vacuum, locks, etc.).

CRITICAL INSTRUCTIONS:
1. Do NOT assume predefined scenarios or hardcode assumptions. Find what actually co-occurs in the user's data.
2. Identify when an environmental, temporal, or situational trigger (e.g. resident heading home, sunset, temperature drop/rise, leaving a room, waking up) reliably precedes a user action on another device within a reasonable time window.
3. Extract generalizable rules so the proactive agent can anticipate the user's intention in future occurrences.
4. Output all titles and descriptions in natural, friendly Dutch.

Return valid JSON format:
{
  "correlations": [
    {
      "title": "Korte Nederlandse titel",
      "description": "Uitleg in het Nederlands over de ontdekte gewoonte",
      "trigger_entity_id": "entity of trigger",
      "trigger_state": "trigger status or event",
      "conditions": {
        "outdoor_temp_lte": 15,
        "outdoor_temp_gte": 25,
        "outdoor_weather": "rainy"
      },
      "action_entity_id": "target entity id",
      "action_service": "service to call",
      "action_data": {},
      "confidence": 0.85,
      "occurrence_count": 3
    }
  ]
}
If no reliable pattern is found, return { "correlations": [] }.
`;

                    // Autonomous correlation mining using Gemini 3.1 Pro with deep reasoning
                    const llmResponse = await chatCompletion(
                        [
                            { role: 'system', content: MINER_PROMPT },
                            { role: 'user', content: `TRACE DATA:\n${traceLines}` }
                        ],
                        4000,
                        0.2,
                        undefined,
                        undefined,
                        'google/gemini-3.1-pro-preview',
                        { effort: 'high' }
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
                        }, { onConflict: 'connection_id, trigger_entity_id, trigger_state, action_entity_id, action_service' });

                        correlationsFound++;
                        discoveredRules.push(rule);
                    }
                }
            } catch (corrErr) {
                console.error('[Habits] Autonomous correlation mining error:', corrErr);
            }

            return jsonResponse({
                success: true,
                analyzed_chats: chats.length,
                patterns_found: significantPatterns.length,
                correlations_found: correlationsFound,
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
        // GET /predict - Get predictions for current time
        // =============================================
        if (path === '/predict' && req.method === 'GET') {
            const now = new Date();
            const currentHour = now.getHours();
            const currentDay = now.getDay();

            // Get patterns for current time (±1 hour window)
            const { data: patterns } = await supabase
                .from('behavior_patterns')
                .select('*')
                .eq('connection_id', connectionId)
                .eq('suppressed', false)
                .gte('occurrence_count', MIN_OCCURRENCES)
                .or(`day_of_week.eq.${currentDay},day_of_week.is.null`)
                .gte('hour', currentHour - 1)
                .lte('hour', currentHour + 1)
                .order('confidence', { ascending: false })
                .limit(5);

            if (!patterns || patterns.length === 0) {
                return jsonResponse({
                    success: true,
                    predictions: [],
                    message: 'No predictions for current time'
                });
            }

            // Get HA connection for friendly names
            const { data: conn } = await supabase
                .from('ha_connections')
                .select('api_url, api_token')
                .eq('id', connectionId)
                .single();

            let friendlyNames: Record<string, string> = {};
            if (conn) {
                try {
                    const statesRes = await fetch(`${conn.api_url}/api/states`, {
                        headers: { "Authorization": `Bearer ${conn.api_token}` }
                    });
                    if (statesRes.ok) {
                        const states = await statesRes.json();
                        friendlyNames = Object.fromEntries(
                            states.map((s: any) => [s.entity_id, s.attributes?.friendly_name || s.entity_id])
                        );
                    }
                } catch (e) {
                    console.error('[Habits] Failed to fetch states:', e);
                }
            }

            const predictions = patterns.map(p => ({
                pattern_id: p.id,
                entity_id: p.entity_id,
                friendly_name: friendlyNames[p.entity_id] || p.entity_id,
                service: p.service,
                confidence: Math.round(p.confidence * 100),
                occurrences: p.occurrence_count,
                suggestion: `You usually ${p.service.replace('.', ' ')} ${friendlyNames[p.entity_id] || p.entity_id} around ${p.hour}:00. Should I?`
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

            if (!patternId) {
                return jsonResponse({ error: 'pattern_id required' }, 400);
            }

            const { error } = await supabase
                .from('behavior_patterns')
                .update({ suppressed: true })
                .eq('id', patternId)
                .eq('connection_id', connectionId);

            if (error) throw error;

            return jsonResponse({
                success: true,
                message: 'Pattern suppressed. Will no longer suggest this action.'
            });
        }

        return jsonResponse({ error: 'Endpoint not found', path }, 404);

    } catch (err: any) {
        console.error('[Habits] Error:', err);
        return jsonResponse({ error: err.message }, 500);
    }
});
