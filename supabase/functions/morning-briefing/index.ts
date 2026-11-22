/**
 * Morning Briefing - Personalized daily summary
 * Triggered via pg_cron or on-demand from Butler App / AI.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from '../_shared/auth.ts';
import { fetchHAStates } from '../_shared/ha-api.ts';
import { chatCompletion } from '../_shared/llm-service.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jsonResponse(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
}

interface BriefingContext {
    weather?: { temp: number; condition: string; forecast: string };
    energy?: { overnight_kwh: number; cost: number; comparison: string };
    presence?: { home: string[]; away: string[] };
    anomalies?: { count: number; summary: string };
    predictions?: { suggestions: string[] };
}

async function generateBriefingText(context: BriefingContext, language: string = 'nl'): Promise<string> {
    const isDutch = language.toLowerCase().startsWith('nl');
    const prompt = `Generate a friendly, concise morning briefing in ${isDutch ? 'Dutch' : 'English'}.

CONTEXT:
${context.weather ? `Weather: ${context.weather.temp}°C, ${context.weather.condition}. ${context.weather.forecast}` : 'Weather: unavailable'}
${context.energy ? `Energy: Used ${context.energy.overnight_kwh}kWh (${context.energy.comparison}). Estimated cost: €${context.energy.cost.toFixed(2)}` : ''}
${context.presence ? `Presence: Home: ${context.presence.home.join(', ') || 'nobody'}. Away: ${context.presence.away.join(', ') || 'nobody'}` : ''}
${context.anomalies && context.anomalies.count > 0 ? `Anomalies: ${context.anomalies.summary}` : ''}
${context.predictions && context.predictions.suggestions.length > 0 ? `Predictions: ${context.predictions.suggestions.join('. ')}` : ''}

Rules:
- Be concise, friendly, and helpful
- Start with "${isDutch ? 'Goedemorgen!' : 'Good morning!'}"
- Mention only relevant available info (skip unavailable data)
- Max 3-4 sentences`;

    try {
        const text = await chatCompletion(
            [{ role: 'user', content: prompt }],
            300,
            0.5,
            undefined,
            undefined,
            undefined,
            { effort: 'low' },
            'high_accuracy'
        );
        return (typeof text === 'string' && text.trim())
            ? text.trim()
            : (isDutch ? 'Goedemorgen! Maak er een fijne dag van.' : 'Good morning! Have a great day.');
    } catch (e) {
        console.error('[Briefing] LLM error:', e);
        let text = isDutch ? 'Goedemorgen! ' : 'Good morning! ';
        if (context.weather) text += isDutch
            ? `Het is ${context.weather.temp}°C (${context.weather.condition}). `
            : `It's ${context.weather.temp}°C and ${context.weather.condition}. `;
        if (context.energy) text += isDutch
            ? `Energieverbruik: ${context.energy.overnight_kwh} kWh. `
            : `Energy usage: ${context.energy.overnight_kwh}kWh. `;
        if (context.anomalies?.count) text += `${context.anomalies.summary} `;
        return text.trim();
    }
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(req.url);

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

        if (!connectionId) {
            return jsonResponse({ error: 'connection_id required' }, 400);
        }

        const ownership = await verifyConnectionOwnership(supabase, auth, connectionId);
        if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);
        const conn = ownership.connection;

        const { data: prefs } = await supabase
            .from('user_preferences')
            .select('*')
            .eq('connection_id', connectionId)
            .maybeSingle();

        const context: BriefingContext = {};

        // Fetch HA states ONCE (reuse for weather, presence, and energy!)
        let states: any[] = [];
        try {
            states = await fetchHAStates(conn);
        } catch (e) {
            console.error('[Briefing] HA fetch error:', e);
        }

        if (states.length > 0) {
            const weather = states.find((s: any) => s.entity_id?.startsWith('weather.'));
            if (weather) {
                context.weather = {
                    temp: Math.round(Number(weather.attributes?.temperature || 0)),
                    condition: weather.state || 'unknown',
                    forecast: weather.attributes?.forecast?.[0]?.condition || ''
                };
            }

            const persons = states.filter((s: any) => s.entity_id?.startsWith('person.'));
            if (persons.length > 0) {
                context.presence = {
                    home: persons.filter((p: any) => p.state === 'home').map((p: any) => p.attributes?.friendly_name || p.entity_id),
                    away: persons.filter((p: any) => p.state !== 'home').map((p: any) => p.attributes?.friendly_name || p.entity_id)
                };
            }

            if (prefs?.briefing_include_energy !== false) {
                const energySensor = states.find((s: any) =>
                    s.entity_id?.includes('energy') &&
                    s.entity_id?.includes('daily') &&
                    !isNaN(parseFloat(s.state))
                );
                if (energySensor) {
                    const kwh = parseFloat(energySensor.state);
                    context.energy = {
                        overnight_kwh: Math.round(kwh * 10) / 10,
                        cost: kwh * 0.25,
                        comparison: kwh < 5 ? 'lower than usual' : kwh > 15 ? 'higher than usual' : 'about average'
                    };
                }
            }
        }

        // Recent anomalies
        const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
        const { data: anomalies } = await supabase
            .from('anomaly_events')
            .select('message, severity')
            .eq('connection_id', connectionId)
            .gte('created_at', eightHoursAgo)
            .eq('acknowledged', false);

        if (anomalies && anomalies.length > 0) {
            const critical = anomalies.filter((a: any) => a.severity === 'critical');
            context.anomalies = {
                count: anomalies.length,
                summary: critical.length > 0
                    ? critical.map((a: any) => a.message).join('. ')
                    : `${anomalies.length} afwijking(en) gedetecteerd`
            };
        }

        // Upcoming predictions (handles midnight wrap cleanly)
        const nowHour = new Date().getHours();
        const upcomingHours = [nowHour, (nowHour + 1) % 24, (nowHour + 2) % 24];
        const { data: predictions } = await supabase
            .from('behavior_patterns')
            .select('entity_id, service, hour')
            .eq('connection_id', connectionId)
            .eq('suppressed', false)
            .gte('occurrence_count', 3)
            .in('hour', upcomingHours)
            .limit(2);

        if (predictions && predictions.length > 0) {
            context.predictions = {
                suggestions: predictions.map((p: any) =>
                    `${p.service?.split('.')[1] || p.service} op ${p.entity_id?.split('.')[1] || p.entity_id} rond ${p.hour}:00`
                )
            };
        }

        const language = body.language || prefs?.preferred_language || prefs?.language || 'nl';
        const briefingText = await generateBriefingText(context, language);

        return jsonResponse({
            success: true,
            briefing: briefingText,
            message: briefingText,
            context,
            speak_aloud: prefs?.briefing_speak_aloud !== false
        });

    } catch (err: any) {
        console.error('[Briefing] Error:', err);
        return jsonResponse({ error: err.message }, 500);
    }
});
