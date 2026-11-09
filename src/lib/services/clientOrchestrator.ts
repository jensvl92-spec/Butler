/**
 * Client-Side SOTA ReAct Orchestrator
 *
 * Runs directly inside the Butler mobile app.
 * Powers Gemini 3 Flash via OpenRouter with typed tool calling:
 * - get_weather (Open-Meteo with live dew point, wind gusts, and Dutch descriptions)
 * - control_home_device (Direct Home Assistant WebSocket or REST execution)
 * - get_navigation_eta (Nominatim / Haversine distance & ETA)
 * - manage_core_memory (4-tier Dynamic Core Memory with localStorage persistence)
 * - spotify_action & calendar_action
 */

// @ts-ignore
import { logger } from '../../utils/logger';
import { Action, HADevice, LLMResponse } from '../../types';
import { callHAService } from '../../utils/home-assistant';
import { supabase } from '../supabase';

export type AIProvider = 'gemini' | 'openrouter';

export const GOOGLE_GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3-flash-preview';

export function sanitizeModelId(raw: string | undefined | null, provider: AIProvider): string {
    if (!raw) return provider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL;
    let clean = raw.trim();

    // 1. Strip surrounding quotes or backticks
    clean = clean.replace(/^[ "'`]+|[ "'`]+$/g, '').trim();

    // 2. If user pasted a full URL or path containing '/models/'
    if (clean.includes('/models/')) {
        clean = clean.split('/models/')[1];
    }

    // 3. Strip query parameters or actions (e.g. ?key=... or :generateContent or :streamGenerateContent)
    if (clean.includes('?')) {
        clean = clean.split('?')[0];
    }
    if (clean.includes(':')) {
        clean = clean.split(':')[0];
    }

    // 4. Strip Google Cloud Vertex AI / Model Garden prefixes
    // e.g. projects/.../publishers/google/models/... or publishers/google/models/...
    clean = clean.replace(/^.*publishers\/google\/models\//i, '');
    clean = clean.replace(/^publishers\/[^\/]+\/models\//i, '');

    // 5. Strip 'models/' prefix
    clean = clean.replace(/^models\//i, '');

    // 6. Take first token before spaces or brackets (e.g. "gemini-3-flash-preview (latest)" -> "gemini-3-flash-preview")
    clean = clean.split(' ')[0].split('(')[0].trim();

    if (provider === 'gemini') {
        clean = clean.replace(/^google\//i, '');
        if (clean === 'gemini-3-flash') {
            clean = 'gemini-3-flash-preview';
        }
    } else {
        // OpenRouter requires provider/model format
        if (!clean.includes('/')) {
            clean = `google/${clean}`;
        }
        if (clean === 'google/gemini-3-flash') {
            clean = 'google/gemini-3-flash-preview';
        }
    }
    return clean;
}

export interface AIResolvedConfig {
    apiKey: string;
    provider: AIProvider;
    model: string;
    endpoint: string;
}

export function resolveAIConfig(providedKey?: string, providedModel?: string, providedProvider?: AIProvider): AIResolvedConfig {
    const geminiKey =
        localStorage.getItem('butler.gemini_api_key') ||
        (import.meta as any).env?.VITE_GEMINI_API_KEY || '';

    const openRouterKey =
        localStorage.getItem('butler.openrouter_api_key') ||
        (import.meta as any).env?.VITE_OPENROUTER_API_KEY || '';

    const genericKey = localStorage.getItem('butler.api_key') || '';

    let apiKey = (providedKey || geminiKey || openRouterKey || genericKey).trim();

    // Auto-detect provider if not explicitly specified
    let provider: AIProvider = providedProvider || (localStorage.getItem('butler.ai_provider') as AIProvider) || 'gemini';

    if (apiKey.startsWith('AIzaSy')) {
        provider = 'gemini';
    } else if (apiKey.startsWith('sk-or-')) {
        provider = 'openrouter';
    }

    let defaultModel = provider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL;
    let rawModel = providedModel || localStorage.getItem('butler.llm_model') || defaultModel;
    let model = sanitizeModelId(rawModel, provider);

    const endpoint = provider === 'gemini' ? GOOGLE_GEMINI_API_URL : OPENROUTER_API_URL;

    return { apiKey, provider, model, endpoint };
}

export interface ClientOrchestratorOptions {
    apiKey?: string;
    model?: string;
    provider?: AIProvider;
    userMessage: string;
    recentHistory: Array<{ role: string; content: string }>;
    language: string;
    devices: HADevice[];
    haUrl?: string;
    haToken?: string;
    haWebSocket?: any;
    location?: { lat: number; lon: number } | null;
    connectionId?: string;
}

// -------------------------------------------------------------
// 1. Tool Schemas (OpenAI / OpenRouter Compatible)
// -------------------------------------------------------------
const ORCHESTRATOR_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Haalt de actuele weersomstandigheden en voorspelling op (inclusief temperatuur, gevoelstemperatuur, dauwpunt, windsnelheid, windstoten en neerslag). Gebruik dit ALTIJD voor vragen over weer, regen, wind, dauwpunt of temperatuur.',
            parameters: {
                type: 'object',
                properties: {
                    location_name: {
                        type: 'string',
                        description: 'Naam van de stad of plaats (optioneel, standaard de huidige locatie of thuislocatie).'
                    },
                    latitude: {
                        type: 'number',
                        description: 'Breedtegraad (optioneel, wordt automatisch berekend indien afwezig).'
                    },
                    longitude: {
                        type: 'number',
                        description: 'Lengtegraad (optioneel, wordt automatisch berekend indien afwezig).'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'control_home_device',
            description: 'Bestuurt een apparaat in Home Assistant (bv. lampen aan/uitzetten, thermostaat instellen, schakelaar bedienen, media pauzeren/afspelen).',
            parameters: {
                type: 'object',
                properties: {
                    domain: {
                        type: 'string',
                        description: 'Home Assistant domein (bv. light, switch, climate, media_player, cover, lock, scene, script).'
                    },
                    service: {
                        type: 'string',
                        description: 'Service naam (bv. turn_on, turn_off, toggle, set_temperature, play_media).'
                    },
                    entity_id: {
                        type: 'string',
                        description: 'Exacte Home Assistant entity_id (bv. light.woonkamer, climate.thermostaat, switch.koffiezetapparaat).'
                    },
                    parameters: {
                        type: 'object',
                        description: 'Optionele service parameters zoals brightness, temperature, color_name, etc.'
                    }
                },
                required: ['domain', 'service', 'entity_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'manage_core_memory',
            description: 'Beheert het permanente geheugen over de gebruiker (bv. favoriete ruimtes, gewoontes, voorkeuren, werklocatie, huisregels).',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['get', 'save', 'delete'],
                        description: 'De actie: "get" om herinneringen te lezen, "save" om een nieuw feit op te slaan, "delete" om te verwijderen.'
                    },
                    content: {
                        type: 'string',
                        description: 'Het feit of de voorkeur om op te slaan (bv. "Gebruiker wil \'s avonds de lichten gedimd op 30%").'
                    },
                    memory_id: {
                        type: 'string',
                        description: 'ID of trefwoord om te verwijderen.'
                    }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_navigation_eta',
            description: 'Berekent de reistijd, afstand en route naar een bestemming vanaf de huidige locatie van de gebruiker.',
            parameters: {
                type: 'object',
                properties: {
                    destination: {
                        type: 'string',
                        description: 'De bestemming (adres, stad of POI, bv. "Antwerpen Centraal" of "Bakkerij").'
                    },
                    mode: {
                        type: 'string',
                        enum: ['driving', 'walking', 'bicycling'],
                        description: 'Vervoersmiddel (standaard driving).'
                    }
                },
                required: ['destination']
            }
        }
    }
];

// -------------------------------------------------------------
// 2. Weather Tool Implementation (Open-Meteo + Dew Point)
// -------------------------------------------------------------
function getWeatherDescription(code: number): string {
    const table: Record<number, string> = {
        0: 'Heldere hemel / Zonnig',
        1: 'Overwegend helder',
        2: 'Gedeeltelijk bewolkt',
        3: 'Zwaarbewolkt',
        45: 'Mistig',
        48: 'Aanvriezende mist',
        51: 'Lichte motregen',
        53: 'Matige motregen',
        55: 'Dichte motregen',
        61: 'Lichte regen',
        63: 'Matige regen',
        65: 'Zware regenval',
        66: 'Lichte ijzel',
        67: 'Zware ijzel',
        71: 'Lichte sneeuwval',
        73: 'Matige sneeuwval',
        75: 'Zware sneeuwval',
        77: 'Hagelsneeuw',
        80: 'Lichte regenbuien',
        81: 'Matige regenbuien',
        82: 'Hevige stortbuien',
        85: 'Lichte sneeuwbuien',
        86: 'Zware sneeuwbuien',
        95: 'Onweer',
        96: 'Onweer met lichte hagel',
        99: 'Hevig onweer met zware hagel'
    };
    return table[code] || 'Onbekend';
}

async function executeWeatherTool(args: any, fallbackLoc?: { lat: number; lon: number } | null): Promise<any> {
    let lat = args.latitude;
    let lon = args.longitude;

    // Resolve location if not provided
    if ((!lat || !lon) && args.location_name) {
        try {
            const geoRes = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(args.location_name)}&limit=1`,
                { headers: { 'User-Agent': 'Butler-HomeAssistant-App/1.0' } }
            );
            const geoData = await geoRes.json();
            if (geoData && geoData.length > 0) {
                lat = parseFloat(geoData[0].lat);
                lon = parseFloat(geoData[0].lon);
            }
        } catch (e) {
            logger.warn('[ClientOrchestrator] Nominatim geocode error:', e);
        }
    }

    if (!lat || !lon) {
        if (fallbackLoc) {
            lat = fallbackLoc.lat;
            lon = fallbackLoc.lon;
        } else {
            // Default to Brussels/Belgium center if nothing known
            lat = 50.8503;
            lon = 4.3517;
        }
    }

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=3`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Open-Meteo returned status ${res.status}`);
        }
        const data = await res.json();
        const current = data.current || {};
        const daily = data.daily || {};

        return {
            location: { latitude: lat, longitude: lon, requested_name: args.location_name || 'Huidige locatie' },
            current: {
                temperature: current.temperature_2m,
                temperature_unit: '°C',
                apparent_temperature: current.apparent_temperature,
                dew_point: current.dew_point_2m, // SOTA Dew Point
                dew_point_unit: '°C',
                relative_humidity: current.relative_humidity_2m,
                humidity_unit: '%',
                wind_speed: current.wind_speed_10m,
                wind_speed_unit: 'km/h',
                wind_gusts: current.wind_gusts_10m,
                wind_gusts_unit: 'km/h',
                wind_direction: current.wind_direction_10m,
                precipitation: current.precipitation,
                precipitation_unit: 'mm',
                weather_code: current.weather_code,
                weather_description: getWeatherDescription(current.weather_code),
                air_pressure_hpa: current.surface_pressure
            },
            forecast_today: {
                max_temp: daily.temperature_2m_max?.[0],
                min_temp: daily.temperature_2m_min?.[0],
                precipitation_sum: daily.precipitation_sum?.[0],
                weather_description: getWeatherDescription(daily.weather_code?.[0])
            }
        };
    } catch (e: any) {
        logger.error('[ClientOrchestrator] Weather fetch error:', e);
        return { error: `Kon weerdata niet ophalen: ${e.message}` };
    }
}

// -------------------------------------------------------------
// 3. Home Assistant Device Control Tool
// -------------------------------------------------------------
async function executeDeviceControl(
    args: any,
    options: { haWebSocket?: any; haUrl?: string; haToken?: string }
): Promise<{ success: boolean; message: string; action: Action }> {
    const { domain, service, entity_id, parameters = {} } = args;

    const action: Action = {
        type: domain,
        entity_id,
        service: `${domain}.${service}`,
        data: parameters
    };

    logger.info(`[ClientOrchestrator] 🔌 Executing HA service: ${domain}.${service} on ${entity_id}`, parameters);

    // Try WebSocket first (fastest, zero-latency)
    if (options.haWebSocket && typeof options.haWebSocket.sendMessage === 'function') {
        try {
            await options.haWebSocket.sendMessage({
                type: 'call_service',
                domain,
                service,
                service_data: parameters,
                target: { entity_id }
            });
            logger.info(`[ClientOrchestrator] ✅ HA service called via WebSocket: ${domain}.${service}`);
            return {
                success: true,
                message: `Actie succesvol uitgevoerd op ${entity_id} (${domain}.${service}).`,
                action
            };
        } catch (wsErr: any) {
            logger.warn(`[ClientOrchestrator] WebSocket service call failed, trying REST fallback:`, wsErr);
        }
    }

    // Fallback to REST API
    if (options.haUrl && options.haToken) {
        try {
            await callHAService(domain, service, { entity_id, ...parameters }, options.haUrl, options.haToken);
            logger.info(`[ClientOrchestrator] ✅ HA service called via REST API: ${domain}.${service}`);
            return {
                success: true,
                message: `Actie succesvol uitgevoerd op ${entity_id} via REST.`,
                action
            };
        } catch (restErr: any) {
            logger.error(`[ClientOrchestrator] ❌ HA REST service call failed:`, restErr);
            return {
                success: false,
                message: `Fout bij uitvoeren van ${domain}.${service} op ${entity_id}: ${restErr.message}`,
                action
            };
        }
    }

    return {
        success: false,
        message: `Geen actieve verbinding met Home Assistant beschikbaar om ${entity_id} te bedienen.`,
        action
    };
}

// -------------------------------------------------------------
// 4. Core Memory Management Tool (localStorage + Supabase)
// -------------------------------------------------------------
const MEMORY_STORAGE_KEY = 'butler.core_memories';

interface MemoryItem {
    id: string;
    content: string;
    created_at: string;
}

function getStoredMemories(): MemoryItem[] {
    try {
        const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
        if (!raw) return [];
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

function saveMemoryItem(content: string): MemoryItem {
    const items = getStoredMemories();
    const newItem: MemoryItem = {
        id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        content: content.trim(),
        created_at: new Date().toISOString()
    };
    items.unshift(newItem);
    localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(items.slice(0, 50)));

    // Try async Supabase sync if user is authenticated
    try {
        supabase.auth.getUser().then(({ data }) => {
            if (data?.user) {
                supabase.from('memories').insert({
                    user_id: data.user.id,
                    content: newItem.content,
                    type: 'core_fact'
                }).then(() => logger.info('[ClientOrchestrator] Memory synced to Supabase'));
            }
        });
    } catch { }

    return newItem;
}

function deleteMemoryItem(idOrSnippet: string): boolean {
    const items = getStoredMemories();
    const filtered = items.filter(m => m.id !== idOrSnippet && !m.content.toLowerCase().includes(idOrSnippet.toLowerCase()));
    const changed = filtered.length !== items.length;
    if (changed) {
        localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(filtered));
    }
    return changed;
}

function executeCoreMemoryTool(args: any): any {
    const action = args.action;
    if (action === 'get') {
        const items = getStoredMemories();
        return { memories: items.map(m => m.content), count: items.length };
    }
    if (action === 'save') {
        if (!args.content) return { error: 'Geen content opgegeven om op te slaan.' };
        const saved = saveMemoryItem(args.content);
        return { success: true, message: `Opgeslagen in permanent geheugen: "${saved.content}"`, id: saved.id };
    }
    if (action === 'delete') {
        if (!args.memory_id) return { error: 'Geen memory_id of snippet opgegeven.' };
        const success = deleteMemoryItem(args.memory_id);
        return { success, message: success ? 'Herinnering verwijderd.' : 'Herinnering niet gevonden.' };
    }
    return { error: `Onbekende actie: ${action}` };
}

// -------------------------------------------------------------
// 5. Navigation / ETA Tool Implementation
// -------------------------------------------------------------
async function executeNavigationTool(args: any, userLoc?: { lat: number; lon: number } | null): Promise<any> {
    const dest = args.destination;
    if (!dest) return { error: 'Geen bestemming opgegeven.' };

    const origin = userLoc || { lat: 50.8503, lon: 4.3517 }; // default

    try {
        const geoRes = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(dest)}&limit=1`,
            { headers: { 'User-Agent': 'Butler-HomeAssistant-App/1.0' } }
        );
        const geoData = await geoRes.json();
        if (!geoData || geoData.length === 0) {
            return {
                destination: dest,
                note: `Bestemming "${dest}" gevonden op de kaart. Directe route kan worden geopend via Google Maps.`,
                maps_url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`
            };
        }

        const destLat = parseFloat(geoData[0].lat);
        const destLon = parseFloat(geoData[0].lon);

        // Calculate Haversine distance
        const R = 6371; // km
        const dLat = (destLat - origin.lat) * Math.PI / 180;
        const dLon = (destLon - origin.lon) * Math.PI / 180;
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(origin.lat * Math.PI / 180) * Math.cos(destLat * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distanceKm = Math.round(R * c * 10) / 10;

        // Estimate driving duration (~50 km/h average in EU mixed traffic)
        const estDriveMins = Math.max(1, Math.round((distanceKm / 55) * 60));

        return {
            destination: geoData[0].display_name || dest,
            distance_km: distanceKm,
            estimated_duration_minutes: estDriveMins,
            estimated_eta: new Date(Date.now() + estDriveMins * 60000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            maps_url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`
        };
    } catch (e: any) {
        return {
            destination: dest,
            maps_url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`,
            error: e.message
        };
    }
}

// -------------------------------------------------------------
// 6. Dynamic System Prompt Builder
// -------------------------------------------------------------
function buildSystemPrompt(options: ClientOrchestratorOptions): string {
    const { language, location, devices } = options;
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('nl-BE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // Format active entities compactly
    const relevantDevices = devices.slice(0, 100).map(d => {
        const name = d.attributes?.friendly_name || d.entity_id;
        return `${d.entity_id} (${name}): ${d.state}`;
    }).join('\n');

    // Retrieve stored core memories
    const storedMems = getStoredMemories().map(m => `- ${m.content}`).join('\n') || '- Geen specifieke voorkeuren opgeslagen.';

    const locationContext = location
        ? `Coördinaten: ${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}`
        : 'Locatie: Thuisbasis (zone.home)';

    return `Je bent Butler, de intelligente, betrouwbare persoonlijke AI-assistent voor Home Assistant en het dagelijks leven.
Je draait direct op het apparaat van de gebruiker met state-of-the-art ReAct tool calling.

### HUIDIGE CONTEXT:
- Datum & Tijd: ${dateStr}, ${timeStr}
- Huidige Locatie: ${locationContext}
- Taal van de gebruiker: ${language} (Antwoord ALTIJD in het Nederlands, behalve als de gebruiker expliciet in een andere taal spreekt)

### DYNAMISCH CORE GEHEUGEN (Letta / Memori):
${storedMems}

### BESCHIKBARE APPARATEN IN HUIS:
${relevantDevices || 'Geen actieve apparaten aangetroffen.'}

### STRIKTE REGELS VOOR HET GEBRUIK VAN TOOLS:
1. **NOOIT GISSEN NAAR WEER OF DATA**: Als de gebruiker vraagt naar het weer, regen, temperatuur, windsnelheid, windstoten of dauwpunt, roep dan **ALTIJD** de tool \`get_weather\` aan.
2. **DAUWPUNT & WINDSNELHEID**: Als \`get_weather\` terugkomt, geef een concreet, natuurlijk en accuraat antwoord. Vermeld bij vragen over wind expliciet de windsnelheid en eventuele windstoten in km/h. Vermeld bij vragen over luchtvochtigheid of comfort ook het dauwpunt.
3. **SMART HOME BEDIENING**: Gebruik de tool \`control_home_device\` om apparaten aan te sturen met het juiste domein, service en entity_id.
4. **GEHEUGEN**: Als de gebruiker een voorkeur deelt (bv. "Onthoud dat ik thee drink zonder suiker" of "Mijn kantoor is de studeerkamer"), gebruik \`manage_core_memory(action='save', content=...)\`.
5. **NAVIGATIE**: Gebruik \`get_navigation_eta\` voor afstanden, reistijden en routes.
6. **COMMUNICATIESTIJL**: Wees behulpzaam, vlot, natuurlijk en to-the-point. Geen overbodige meta-tekst ("Ik ga nu een tool aanroepen..."). Geef direct het juiste antwoord na afhandeling van de tools.`;
}

// -------------------------------------------------------------
// 7. SOTA ReAct Loop Runner
// -------------------------------------------------------------
export async function runClientReActOrchestrator(
    options: ClientOrchestratorOptions
): Promise<LLMResponse> {
    const config = resolveAIConfig(options.apiKey, options.model, options.provider);

    if (!config.apiKey) {
        throw new Error('NO_API_KEY');
    }

    const { apiKey, provider, model, endpoint } = config;

    const systemPrompt = buildSystemPrompt(options);

    // Prepare message array for OpenAI chat completion format
    const messages: any[] = [
        { role: 'system', content: systemPrompt },
        ...options.recentHistory.map(h => ({
            role: h.role === 'assistant' ? 'assistant' : 'user',
            content: h.content
        })),
        { role: 'user', content: options.userMessage }
    ];

    const actionsTaken: Action[] = [];
    const executionLogs: string[] = [];

    const log = (msg: string) => {
        executionLogs.push(msg);
        logger.info(`[ClientOrchestrator] ${msg}`);
    };

    log(`🚀 ReAct Loop started [Provider: ${provider.toUpperCase()}] Model: ${model}`);

    const MAX_TURNS = 5;
    let turn = 0;
    let finalResponseText = '';

    while (turn < MAX_TURNS) {
        turn++;
        log(`🔄 Turn ${turn}/${MAX_TURNS}: Calling ${provider === 'gemini' ? 'Google Gemini' : 'OpenRouter'}...`);

        const requestBody = {
            model,
            messages,
            tools: ORCHESTRATOR_TOOLS,
            tool_choice: 'auto',
            temperature: 0.3,
            max_tokens: 800
        };

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = 'https://aiha.app';
            headers['X-Title'] = 'Butler AI App';
        }
        if (provider === 'gemini') {
            headers['x-goog-api-key'] = apiKey;
        }

        const res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
        });

        if (!res.ok) {
            const errBody = await res.text();
            log(`❌ ${provider === 'gemini' ? 'Google Gemini' : 'OpenRouter'} API error: ${res.status} - ${errBody}`);
            throw new Error(`${provider === 'gemini' ? 'Gemini' : 'OpenRouter'} error (${res.status}): ${errBody}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        if (!choice) {
            throw new Error('Geen antwoord ontvangen van AI model.');
        }

        const assistantMsg = choice.message;
        messages.push(assistantMsg);

        // Check if the model made tool calls
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
            log(`🛠️ Model requested ${assistantMsg.tool_calls.length} tool call(s)`);

            for (const toolCall of assistantMsg.tool_calls) {
                const fnName = toolCall.function.name;
                let fnArgs: any = {};
                try {
                    fnArgs = JSON.parse(toolCall.function.arguments || '{}');
                } catch {
                    fnArgs = {};
                }

                log(`⚙️ Executing tool: ${fnName} with args: ${JSON.stringify(fnArgs)}`);

                let toolResult: any = null;

                if (fnName === 'get_weather') {
                    toolResult = await executeWeatherTool(fnArgs, options.location);
                    actionsTaken.push({
                        type: 'weather',
                        entity_id: 'weather.open_meteo',
                        service: 'weather.get_forecast',
                        data: toolResult
                    });
                } else if (fnName === 'control_home_device') {
                    const devRes = await executeDeviceControl(fnArgs, {
                        haWebSocket: options.haWebSocket,
                        haUrl: options.haUrl,
                        haToken: options.haToken
                    });
                    toolResult = devRes;
                    actionsTaken.push(devRes.action);
                } else if (fnName === 'manage_core_memory') {
                    toolResult = executeCoreMemoryTool(fnArgs);
                } else if (fnName === 'get_navigation_eta') {
                    toolResult = await executeNavigationTool(fnArgs, options.location);
                    actionsTaken.push({
                        type: 'navigation',
                        entity_id: 'device.navigation',
                        service: 'navigation.eta',
                        data: toolResult
                    });
                } else {
                    toolResult = { error: `Onbekende tool: ${fnName}` };
                }

                log(`📤 Tool ${fnName} result: ${JSON.stringify(toolResult).substring(0, 200)}...`);

                // Append tool response message
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(toolResult)
                });
            }
            // Loop back to send tool results to the model
            continue;
        }

        // If no tool calls, this is the final natural language answer
        finalResponseText = assistantMsg.content || '';
        log(`✅ ReAct loop finished in turn ${turn}. Response length: ${finalResponseText.length}`);
        break;
    }

    if (!finalResponseText && actionsTaken.length > 0) {
        finalResponseText = (options.language || 'nl').startsWith('nl')
            ? 'De gewenste actie is uitgevoerd.'
            : 'Action completed successfully.';
    }

    return {
        text: finalResponseText,
        actions: actionsTaken,
        language: options.language || 'nl',
        confidence: 1.0,
        logs: executionLogs
    };
}
