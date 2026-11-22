/**
 * Process AI Command - Supabase Edge Function
 * 
 * SOTA Single ReAct Orchestrator powered by Gemini 3 Flash.
 * Direct tool execution, Dynamic 4-Tier Core Memory, and zero pre-LLM regex intercepts.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { chatCompletion } from "../_shared/llm-service.ts";
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from "../_shared/auth.ts";
import {
    buildDynamicWorkingContext,
    formatWorkingMemoryPrompt,
    saveCoreMemory,
    deleteCoreMemory,
    saveChatHistory
} from "../_shared/memory-service.ts";
import {
    getCurrentWeather,
    getForecast,
    formatWeatherText,
    willItRain
} from "../_shared/services/weather-service.ts";
import {
    getETAFromCoords,
    resolveDestination,
    formatETAText
} from "../_shared/services/maps-service.ts";
import {
    getUpcomingEvents,
    createEvent
} from "../_shared/services/calendar-service.ts";
import {
    searchAndPlay,
    pause,
    next,
    previous
} from "../_shared/services/spotify-service.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = CORS_HEADERS;

interface RequestPayload {
    connection_id: string;
    user_message: string;
    language?: string;
    devices?: any[];
    location?: { lat: number; lon: number; name?: string } | null;
    gps_unavailable?: boolean;
    ha_url?: string;
    ha_token?: string;
    client_timestamp?: string;
    client_timezone?: string;
}

interface AIResponse {
    text: string;
    actions: Array<{
        entity_id: string;
        service: string;
        data?: Record<string, any>;
        action?: string;
        parameters?: Record<string, any>;
    }>;
    language: string;
    logs?: string[];
}

const TOOLS = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "Haal actuele weersinformatie, gevoelstemperatuur, dauwpunt, regenverwachting of meerdaagse voorspelling op.",
            parameters: {
                type: "object",
                properties: {
                    query_type: {
                        type: "string",
                        enum: ["current", "forecast", "dew_point", "rain_check"],
                        description: "Type vraag: current, forecast, dew_point, rain_check"
                    },
                    latitude: { type: "number", description: "Breedtegraad (optioneel)" },
                    longitude: { type: "number", description: "Lengtegraad (optioneel)" }
                },
                required: ["query_type"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_navigation_eta",
            description: "Bereken de actuele reistijd en routebeschrijving naar een bestemming via Google Maps.",
            parameters: {
                type: "object",
                properties: {
                    destination: { type: "string", description: "De doelbestemming (stad, adres of punt)" },
                    mode: { type: "string", enum: ["driving", "walking", "bicycling"], description: "Vervoersmiddel (standaard driving)" }
                },
                required: ["destination"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "control_home_device",
            description: "Schakel of bedien een fysiek apparaat in Home Assistant.",
            parameters: {
                type: "object",
                properties: {
                    domain: { type: "string", description: "Home Assistant domein (bv. light, switch, climate, cover)" },
                    service: { type: "string", description: "Service naam (bv. turn_on, turn_off, set_temperature)" },
                    entity_id: { type: "string", description: "De exacte entity_id" },
                    service_data: { type: "object", description: "Optionele service parameters" }
                },
                required: ["domain", "service", "entity_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "manage_core_memory",
            description: "Sla een permanent feit of voorkeur op in Core Memory, of vergeet een feit.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["save", "delete"] },
                    content: { type: "string" },
                    category: { type: "string", enum: ["preference", "household", "routine", "rule"] }
                },
                required: ["action", "content"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "calendar_action",
            description: "Lees komende afspraken uit Google Agenda of maak een nieuwe afspraak.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["list", "create"] },
                    title: { type: "string" },
                    date: { type: "string", description: "Datum YYYY-MM-DD" },
                    time: { type: "string", description: "Tijd HH:MM" },
                    duration: { type: "number", description: "Duur in minuten (standaard 60)" }
                },
                required: ["action"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "spotify_action",
            description: "Bedien Spotify muziekweergave.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", enum: ["play", "pause", "next", "previous"] },
                    query: { type: "string", description: "Artiest of tracknaam om af te spelen" }
                },
                required: ["command"]
            }
        }
    }
];

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const logs: string[] = [];
    const startTime = Date.now();
    const log = (msg: string) => { console.log(msg); logs.push(msg); };
    const logTime = (step: string) => log(`[TIMING] ${step}: ${Date.now() - startTime}ms`);

    try {
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) {
            return new Response(JSON.stringify({ error: auth.error }), {
                status: auth.status || 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const payload: RequestPayload = await req.json();
        const {
            connection_id,
            user_message,
            language = 'nl-BE',
            devices = [],
            location = null,
            client_timestamp,
            client_timezone
        } = payload;

        logTime('Request parsed');
        log(`[Butler] Request: "${user_message}"`);

        if (!user_message?.trim()) {
            return jsonResponse({
                text: language.startsWith('nl') ? 'Ik heb geen bericht ontvangen.' : 'No message received.',
                actions: [],
                language,
                logs
            });
        }

        if (!connection_id) {
            return new Response(JSON.stringify({ error: 'connection_id required' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const ownership = await verifyConnectionOwnership(supabase, auth, connection_id);
        if (!ownership.valid) {
            return new Response(JSON.stringify({ error: ownership.error }), {
                status: ownership.status || 403,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
        const userId: string = ownership.connection?.user_id || auth.userId || '';

        const workingContext = await buildDynamicWorkingContext(supabase, connection_id, {
            language,
            location,
            devices,
            client_timestamp,
            client_timezone
        });
        const workingMemoryPrompt = formatWorkingMemoryPrompt(workingContext);
        logTime('Dynamic Core Memory assembled');

        let dialogueHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        try {
            const { data: historyRows } = await supabase
                .from('chat_history')
                .select('user_message, ai_response')
                .eq('connection_id', connection_id)
                .order('created_at', { ascending: false })
                .limit(8);

            if (historyRows && historyRows.length > 0) {
                dialogueHistory = historyRows.reverse().flatMap((r: any) => {
                    const aiText = typeof r.ai_response === 'string'
                        ? r.ai_response
                        : (r.ai_response?.text || '');
                    return [
                        { role: 'user' as const, content: r.user_message || '' },
                        { role: 'assistant' as const, content: aiText }
                    ];
                }).filter(m => m.content.trim().length > 0);
            }
        } catch (e) {
            console.warn('[History] Failed to load chat history:', e);
        }

        const controllableDomains = ['light', 'switch', 'climate', 'cover', 'media_player', 'scene'];
        const controllableDevices = (devices || [])
            .filter((d: any) => controllableDomains.includes((d.entity_id || '').split('.')[0]))
            .slice(0, 150)
            .map((d: any) => `- ${d.entity_id}: "${d.attributes?.friendly_name || d.entity_id}" (status: ${d.state || 'onbekend'})`)
            .join('\n');

        const systemPrompt = `
IDENTITY & DOEL:
Je bent Butler, een hoogbegaafde, discrete en proactieve AI-assistent voor een slim huis.
Je communiceert natuurlijk, vriendelijk en to-the-point in het Nederlands (Vlaams/Nederlands).
Omdat jouw antwoorden worden uitgesproken via spraaksynthese (TTS), zijn je antwoorden vlot, natuurlijk en vermijd je overbodige markdown of tabellen.

${workingMemoryPrompt}

[BESCHIKBARE APPARATEN IN HUIS]:
${controllableDevices || 'Geen apparaten geregistreerd.'}

BELANGRIJKE GEDRAGSREGELS:
1. **Tool Calling Eerst**: Voor feitelijke data (weer, dauwpunt, reistijd, agenda, apparaatbediening, geheugen) roep je ALTIJD de bijbehorende tools aan. Verzin nooit data.
2. **Multi-turn Context**: Begrijp vervolgvragen direct aan de hand van de gespreksgeschiedenis.
`.trim();

        const messages: any[] = [
            { role: 'system', content: systemPrompt },
            ...dialogueHistory,
            { role: 'user', content: user_message }
        ];

        const collectedActions: any[] = [];
        let finalResponseText = '';
        let iteration = 0;
        const maxIterations = 4;

        while (iteration < maxIterations) {
            iteration++;
            log(`[ReAct] Iteration ${iteration} calling centralized fast_interactive tier...`);

            const llmResponse = await chatCompletion(
                messages,
                8000,
                0.5,
                TOOLS,
                undefined,
                undefined,
                { effort: 'low' },
                'fast_interactive'
            );

            if (llmResponse?.tool_calls && llmResponse.tool_calls.length > 0) {
                log(`[ReAct] Model selected ${llmResponse.tool_calls.length} tool(s)`);

                const assistantTurn: any = {
                    role: 'assistant',
                    content: llmResponse.content || null,
                    tool_calls: llmResponse.tool_calls
                };
                if (llmResponse.reasoning_details) {
                    assistantTurn.reasoning_details = llmResponse.reasoning_details;
                }
                messages.push(assistantTurn);

                for (const toolCall of llmResponse.tool_calls) {
                    const fnName = toolCall.function?.name;
                    let args: any = {};
                    try {
                        args = JSON.parse(toolCall.function?.arguments || '{}');
                    } catch {
                        args = {};
                    }

                    log(`[ToolCall] Executing: ${fnName}`);
                    let toolResultStr = '';

                    try {
                        if (fnName === 'get_weather') {
                            const lat = args.latitude ?? workingContext.userPersona.location?.lat ?? 51.1488;
                            const lon = args.longitude ?? workingContext.userPersona.location?.lon ?? 5.1271;
                            const weather = await getCurrentWeather(lat, lon, 'nl');

                            if (args.query_type === 'forecast') {
                                const forecast = await getForecast(lat, lon, 'nl');
                                toolResultStr = `Voorspelling: ${forecast.days.map(d => `${d.date}: min ${d.temp_min}°C, max ${d.temp_max}°C, ${d.description}`).join('; ')}`;
                            } else if (args.query_type === 'dew_point') {
                                toolResultStr = weather.dew_point !== undefined
                                    ? `Het actuele dauwpunt is ${weather.dew_point}°C bij een buitentemperatuur van ${weather.temp}°C en luchtvochtigheid van ${weather.humidity}%. ${weather.description}.`
                                    : `Dauwpunt niet beschikbaar; actuele temperatuur ${weather.temp}°C, luchtvochtigheid ${weather.humidity}%.`;
                            } else if (args.query_type === 'rain_check') {
                                const forecast = await getForecast(lat, lon, 'nl');
                                const rain = willItRain(forecast);
                                toolResultStr = `Regenkans vandaag: ${rain.today ? 'Ja, er wordt neerslag verwacht' : 'Nee, het blijft overwegend droog'}. Luchtvochtigheid: ${weather.humidity}%.`;
                            } else {
                                toolResultStr = formatWeatherText(weather, 'nl');
                            }
                        } else if (fnName === 'get_navigation_eta') {
                            const destination = args.destination;
                            const lat = workingContext.userPersona.location?.lat ?? 51.1488;
                            const lon = workingContext.userPersona.location?.lon ?? 5.1271;

                            try {
                                const resolved = await resolveDestination(lat, lon, destination);
                                const target = resolved.resolved || destination;
                                const eta = await getETAFromCoords(lat, lon, target, args.mode || 'driving', 'nl');
                                toolResultStr = formatETAText(eta, 'nl');
                            } catch (navErr: any) {
                                toolResultStr = `Kon route naar "${destination}" niet berekenen: ${navErr.message}`;
                            }
                        } else if (fnName === 'control_home_device') {
                            const domain = args.domain?.toLowerCase();
                            const service = args.service?.toLowerCase();
                            const entityId = args.entity_id;
                            const fullService = service?.includes('.') ? service : `${domain}.${service}`;

                            collectedActions.push({
                                entity_id: entityId,
                                service: fullService,
                                data: args.service_data || {}
                            });
                            toolResultStr = `Actie ${fullService} op ${entityId} klaargezet voor Home Assistant.`;
                        } else if (fnName === 'manage_core_memory') {
                            if (args.action === 'save') {
                                const saved = await saveCoreMemory(supabase, args.content, args.category || 'preference', {}, connection_id);
                                toolResultStr = saved.success ? `Onthouden in Core Memory: "${args.content}"` : 'Kon niet opslaan in geheugen.';
                            } else {
                                const deleted = await deleteCoreMemory(supabase, args.content, connection_id);
                                toolResultStr = deleted ? `Verwijderd uit geheugen: "${args.content}"` : 'Kon niet wissen uit geheugen.';
                            }
                        } else if (fnName === 'spotify_action') {
                            if (userId) {
                                if (args.command === 'play') {
                                    toolResultStr = await searchAndPlay(userId, args.query || '', log);
                                } else if (args.command === 'pause') {
                                    await pause(userId);
                                    toolResultStr = 'Muziek gepauzeerd.';
                                } else if (args.command === 'next') {
                                    await next(userId);
                                    toolResultStr = 'Volgend nummer.';
                                } else if (args.command === 'previous') {
                                    await previous(userId);
                                    toolResultStr = 'Vorig nummer.';
                                }
                            } else {
                                toolResultStr = 'Spotify is nog niet gekoppeld voor deze gebruiker.';
                            }
                        } else if (fnName === 'calendar_action') {
                            if (userId) {
                                if (args.action === 'list') {
                                    const events = await getUpcomingEvents(userId, 5);
                                    toolResultStr = events && events.length > 0
                                        ? `Afspraken: ${events.map((e: any) => `${e.summary} om ${new Date(e.start).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: workingContext.userPersona.timezone })}`).join(', ')}`
                                        : 'Je agenda is vandaag leeg.';
                                } else if (args.action === 'create') {
                                    const startIso = args.date
                                        ? `${args.date}T${args.time || '09:00'}:00`
                                        : new Date().toISOString();
                                    const created = await createEvent(
                                        userId,
                                        args.title || 'Nieuwe afspraak',
                                        startIso,
                                        Number(args.duration) || 60,
                                        workingContext.userPersona.timezone
                                    );
                                    toolResultStr = created
                                        ? `Afspraak "${args.title}" toegevoegd op ${args.date || 'vandaag'} om ${args.time || '09:00'}.`
                                        : 'Kon afspraak niet toevoegen.';
                                }
                            } else {
                                toolResultStr = 'Google Agenda is nog niet gekoppeld voor deze gebruiker.';
                            }
                        } else {
                            toolResultStr = `Onbekende tool: ${fnName}`;
                        }
                    } catch (toolExecErr: any) {
                        console.error(`[ToolExecError] ${fnName}:`, toolExecErr);
                        toolResultStr = `Fout bij uitvoeren van ${fnName}: ${toolExecErr.message}`;
                    }

                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        name: fnName,
                        content: toolResultStr
                    });
                }

                continue;
            }

            if (typeof llmResponse === 'string') {
                finalResponseText = llmResponse.trim();
            } else if (llmResponse?.content) {
                finalResponseText = llmResponse.content.trim();
            }
            break;
        }

        if (!finalResponseText) {
            finalResponseText = collectedActions.length > 0
                ? 'Ik heb het voor je in orde gemaakt.'
                : 'Ik heb je verzoek verwerkt.';
        }

        const responsePayload: AIResponse = {
            text: finalResponseText,
            actions: collectedActions,
            language,
            logs
        };

        await saveChatHistory(
            { connection_id, user_message, language },
            responsePayload,
            collectedActions,
            supabase
        );

        return jsonResponse(responsePayload);

    } catch (error: any) {
        console.error('[ProcessAICommand] Fatal error:', error);
        return jsonResponse({
            text: 'Er is een fout opgetreden bij het verwerken van je vraag.',
            actions: [],
            language: 'nl-BE',
            logs: [...logs, `Fatal Error: ${error.message}`]
        }, 500);
    }
});

function jsonResponse(data: AIResponse, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}
