/**
 * Morning Briefing - Personalized daily summary
 * 
 * Generates a spoken/text briefing combining:
 * - Weather forecast
 * - Energy usage overnight
 * - Presence status
 * - Any anomalies detected
 * - Upcoming events (if calendar connected)
 * 
 * Triggered via pg_cron or manually
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2.38.4"

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const LLM_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || Deno.env.get("GROQ_API_KEY")!

function jsonResponse(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
}

interface BriefingContext {
    weather?: { temp: number; condition: string; forecast: string };
    energy?: { overnight_kwh: number; cost: number; comparison: string };
    presence?: { home: string[]; away: string[] };
    anomalies?: { count: number; summary: string };
    predictions?: { suggestions: string[] };
}

async function generateBriefingText(context: BriefingContext, language: string = 'en'): Promise<string> {
    const prompt = `Generate a friendly morning briefing in ${language === 'nl' ? 'Dutch' : 'English'}.

CONTEXT:
${context.weather ? `Weather: ${context.weather.temp}°C, ${context.weather.condition}. ${context.weather.forecast}` : 'Weather: unavailable'}
${context.energy ? `Energy: Used ${context.energy.overnight_kwh}kWh overnight (${context.energy.comparison}). Cost: €${context.energy.cost.toFixed(2)}` : ''}
${context.presence ? `Presence: Home: ${context.presence.home.join(', ') || 'nobody'}. Away: ${context.presence.away.join(', ') || 'nobody'}` : ''}
${context.anomalies && context.anomalies.count > 0 ? `Anomalies: ${context.anomalies.summary}` : ''}
${context.predictions && context.predictions.suggestions.length > 0 ? `Predictions: ${context.predictions.suggestions.join('. ')}` : ''}

Rules:
- Be concise, friendly, and helpful
- Start with "Good morning!"
- Mention only relevant info (skip unavailable data)
- End with a positive note
- Max 3-4 sentences`;

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${LLM_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 200,
                temperature: 0.7
            })
        });

        if (!response.ok) throw new Error('LLM request failed');
        const data = await response.json();
        return data.choices[0]?.message?.content || 'Good morning! Have a great day.';
    } catch (e) {
        console.error('[Briefing] LLM error:', e);
        // Fallback to template-based briefing
        let text = 'Good morning! ';
        if (context.weather) text += `It's ${context.weather.temp}°C and ${context.weather.condition}. `;
        if (context.energy) text += `You used ${context.energy.overnight_kwh}kWh overnight. `;
        if (context.anomalies?.count) text += `Note: ${context.anomalies.summary} `;
        text += 'Have a great day!';
        return text;
    }
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(req.url);

    try {
        const body = req.method === 'POST' ? await req.json() : {};
        const connectionId = url.searchParams.get('connection_id') || body.connection_id;

        if (!connectionId) {
            return jsonResponse({ error: 'connection_id required' }, 400);
        }

        // Get HA connection
        const { data: conn } = await supabase
            .from('ha_connections')
            .select('*')
            .eq('id', connectionId)
            .single();

        if (!conn) {
            return jsonResponse({ error: 'Connection not found' }, 404);
        }

        // Get user preferences
        const { data: prefs } = await supabase
            .from('user_preferences')
            .select('*')
            .eq('connection_id', connectionId)
            .single();

        const context: BriefingContext = {};

        // =============================================
        // 1. WEATHER
        // =============================================
        try {
            const statesRes = await fetch(`${conn.api_url}/api/states`, {
                headers: { "Authorization": `Bearer ${conn.api_token}` }
            });

            if (statesRes.ok) {
                const states = await statesRes.json();

                // Find weather entity
                const weather = states.find((s: any) => s.entity_id.startsWith('weather.'));
                if (weather) {
                    context.weather = {
                        temp: Math.round(weather.attributes?.temperature || 0),
                        condition: weather.state || 'unknown',
                        forecast: weather.attributes?.forecast?.[0]?.condition || ''
                    };
                }

                // =============================================
                // 2. PRESENCE
                // =============================================
                const persons = states.filter((s: any) => s.entity_id.startsWith('person.'));
                if (persons.length > 0) {
                    context.presence = {
                        home: persons.filter((p: any) => p.state === 'home').map((p: any) => p.attributes?.friendly_name || p.entity_id),
                        away: persons.filter((p: any) => p.state !== 'home').map((p: any) => p.attributes?.friendly_name || p.entity_id)
                    };
                }
            }
        } catch (e) {
            console.error('[Briefing] HA fetch error:', e);
        }

        // =============================================
        // 3. OVERNIGHT ENERGY
        // =============================================
        if (prefs?.briefing_include_energy !== false) {
            try {
                // Find energy sensor
                const statesRes = await fetch(`${conn.api_url}/api/states`, {
                    headers: { "Authorization": `Bearer ${conn.api_token}` }
                });

                if (statesRes.ok) {
                    const states = await statesRes.json();
                    const energySensor = states.find((s: any) =>
                        s.entity_id.includes('energy') &&
                        s.entity_id.includes('daily') &&
                        !isNaN(parseFloat(s.state))
                    );

                    if (energySensor) {
                        const kwh = parseFloat(energySensor.state);
                        // Rough estimate: €0.25 per kWh average
                        const cost = kwh * 0.25;
                        context.energy = {
                            overnight_kwh: Math.round(kwh * 10) / 10,
                            cost: cost,
                            comparison: kwh < 5 ? 'lower than usual' : kwh > 15 ? 'higher than usual' : 'about average'
                        };
                    }
                }
            } catch (e) {
                console.error('[Briefing] Energy fetch error:', e);
            }
        }

        // =============================================
        // 4. RECENT ANOMALIES
        // =============================================
        const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
        const { data: anomalies } = await supabase
            .from('anomaly_events')
            .select('message, severity')
            .eq('connection_id', connectionId)
            .gte('created_at', eightHoursAgo)
            .eq('acknowledged', false);

        if (anomalies && anomalies.length > 0) {
            const critical = anomalies.filter(a => a.severity === 'critical');
            context.anomalies = {
                count: anomalies.length,
                summary: critical.length > 0
                    ? critical.map(a => a.message).join('. ')
                    : `${anomalies.length} minor anomalies detected overnight`
            };
        }

        // =============================================
        // 5. PREDICTIONS
        // =============================================
        const { data: predictions } = await supabase
            .from('behavior_patterns')
            .select('entity_id, service, hour')
            .eq('connection_id', connectionId)
            .eq('suppressed', false)
            .gte('occurrence_count', 3)
            .gte('hour', new Date().getHours())
            .lte('hour', new Date().getHours() + 2)
            .limit(2);

        if (predictions && predictions.length > 0) {
            context.predictions = {
                suggestions: predictions.map(p =>
                    `You usually ${p.service.split('.')[1]} ${p.entity_id.split('.')[1]} around ${p.hour}:00`
                )
            };
        }

        // =============================================
        // GENERATE BRIEFING
        // =============================================
        console.log('[Briefing] Context:', JSON.stringify(context, null, 2));

        const briefingText = await generateBriefingText(context, prefs?.language || 'en');

        return jsonResponse({
            success: true,
            briefing: briefingText,
            context: context,
            speak_aloud: prefs?.briefing_speak_aloud !== false
        });

    } catch (err: any) {
        console.error('[Briefing] Error:', err);
        return jsonResponse({ error: err.message }, 500);
    }
});
