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
import {
    fetchHAHistory,
    fetchHALogbook,
    fetchHACameraSnapshot,
    fetchHATodoItems,
    manageHATodoItem,
    fetchHACalendarEvents
} from '../../utils/ha-api';
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
    },
    {
        type: 'function',
        function: {
            name: 'get_energy_prices',
            description: 'Haalt de actuele stroomprijs, 24-uurs dynamische energie/spotprijzen per uur (vandaag en morgen), daggemiddelde, piek/daluren en het goedkoopste tijdslot op vanuit Home Assistant (Nordpool, ENTSO-E, EPEX Spot, Tibber, Frank Energie, etc.) of live marktprijzen. Gebruik dit ALTIJD bij vragen over stroomprijzen, dynamische tarieven of wanneer het goedkoop is om apparaten te gebruiken.',
            parameters: {
                type: 'object',
                properties: {
                    device_or_sensor: {
                        type: 'string',
                        description: 'Optionele specifieke Home Assistant sensor entity_id (bv. sensor.nordpool_kwh_be_eur_3_10_0). Indien leeg zoekt Butler automatisch naar de actieve spotprijsintegratie.'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_home_entities',
            description: 'Zoekt gericht naar specifieke apparaten, sensoren of entiteiten in Home Assistant op basis van kamernaam, apparaattype of zoekterm. Gebruik dit als een gewenst apparaat niet in de initiële selectie staat of bij vragen zoals "welke lampen staan er in de hal?".',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Trefwoord of apparaatnaam (bv. "leeslamp", "ventilator", "warmtepomp", "deur").'
                    },
                    room: {
                        type: 'string',
                        description: 'Optionele kamernaam (bv. "woonkamer", "slaapkamer", "keuken", "gang", "tuin").'
                    },
                    domain: {
                        type: 'string',
                        description: 'Optioneel Home Assistant domein (bv. "light", "switch", "climate", "cover", "sensor", "media_player").'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_entity_state',
            description: 'Leest de actuele status en alle attributen uit van een specifieke Home Assistant sensor, schakelaar of apparaat, of zoekt entiteiten op trefwoord (bv. "prijs", "stroom", "nordpool", "solar", "warmtepomp", "batterij", "temperatuur").',
            parameters: {
                type: 'object',
                properties: {
                    entity_id_or_search: {
                        type: 'string',
                        description: 'Exacte entity_id of zoekterm om te matchen.'
                    }
                },
                required: ['entity_id_or_search']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_ha_history_and_statistics',
            description: 'Haalt historische data en statistische berekeningen op van een Home Assistant sensor of teller (bv. stroomopbrengst zonnepanelen over 24u/7d, minimum/maximum temperatuur vannacht, kWh verbruik warmtepomp). Berekent automatisch het verschil (delta) en gemiddeldes.',
            parameters: {
                type: 'object',
                properties: {
                    entity_id: {
                        type: 'string',
                        description: 'Exacte entity_id van de sensor (bv. sensor.solar_production_total, sensor.woonkamer_temperatuur).'
                    },
                    hours_ago: {
                        type: 'number',
                        description: 'Hoeveel uur terugkijken (bv. 24 voor afgelopen etmaal, 168 voor afgelopen week, 8 voor afgelopen nacht). Standaard 24.'
                    }
                },
                required: ['entity_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_ha_logbook',
            description: 'Haalt het Home Assistant logboek op om te zien wanneer gebeurtenissen hebben plaatsgevonden en wie/wat ze heeft getriggerd (bv. "Hoe laat ging de voordeur open?", "Wanneer is het alarm ingeschakeld?", "Wie deed het licht aan?").',
            parameters: {
                type: 'object',
                properties: {
                    entity_id: {
                        type: 'string',
                        description: 'Optionele entity_id om specifiek op te filteren (bv. binary_sensor.voordeur_contact).'
                    },
                    hours_ago: {
                        type: 'number',
                        description: 'Aantal uren terug in het logboek (standaard 24).'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'capture_camera_snapshot',
            description: 'Haalt een actuele live snapshot op van een beveiligingscamera of deurbel in Home Assistant en laat deze visueel analyseren door de AI (bv. "Wie staat er aan de deur?", "Ligt er een pakketje op de oprit?", "Staat de garagepoort open?").',
            parameters: {
                type: 'object',
                properties: {
                    camera_entity_id: {
                        type: 'string',
                        description: 'Exacte camera entity_id (bv. camera.voordeur, camera.oprit, camera.tuin).'
                    },
                    question: {
                        type: 'string',
                        description: 'De specifieke visuele vraag van de gebruiker (bv. "Staat er iemand aan de deur?", "Is de poort dicht?").'
                    }
                },
                required: ['camera_entity_id', 'question']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'manage_todo_list',
            description: 'Beheert to-do lijsten en boodschappenlijstjes in Home Assistant (items ophalen, nieuw item toevoegen, afvinken als voltooid, of verwijderen).',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'add', 'complete', 'remove'],
                        description: 'De actie: "list" om items te bekijken, "add" om toe te voegen, "complete" om af te vinken, "remove" om te wissen.'
                    },
                    item_summary: {
                        type: 'string',
                        description: 'De tekst van het item (bv. "Melk", "Brood", "Gras maaien"). Verplicht bij add, complete of remove.'
                    },
                    list_entity_id: {
                        type: 'string',
                        description: 'Optionele entity_id van de lijst (bv. todo.boodschappen, todo.shopping_list). Indien leeg kiest Butler automatisch de actieve lijst.'
                    }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_calendar_events',
            description: 'Haalt agenda-afspraken en kalender-evenementen op uit Home Assistant kalenders (bv. afvalkalender, ophaaldagen voor restafval/PMD/papier, gezinsagenda, of persoonlijke afspraken).',
            parameters: {
                type: 'object',
                properties: {
                    calendar_entity_id: {
                        type: 'string',
                        description: 'Optionele entity_id van de kalender (bv. calendar.afvalkalender, calendar.gezin). Indien leeg doorzoekt Butler alle kalenders.'
                    },
                    days_ahead: {
                        type: 'number',
                        description: 'Aantal dagen vooruitkijken (standaard 7 dagen).'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_home_assistant_automation',
            description: 'Ontwerpt een complete Home Assistant automatisering en presenteert deze als interactieve kaart aan de gebruiker met een directe "Installeer in Home Assistant" knop.',
            parameters: {
                type: 'object',
                properties: {
                    alias: {
                        type: 'string',
                        description: 'Duidelijke en beschrijvende titel van de automatisering (bv. "Automatisch zonwering sluiten bij felle zon").'
                    },
                    description: {
                        type: 'string',
                        description: 'Korte toelichting van wat de automatisering doet.'
                    },
                    trigger: {
                        type: 'array',
                        items: { type: 'object' },
                        description: 'Lijst van triggers in Home Assistant formaat (bv. platform: numeric_state, entity_id: sensor.temperatuur, above: 24).'
                    },
                    condition: {
                        type: 'array',
                        items: { type: 'object' },
                        description: 'Optionele lijst van voorwaarden in Home Assistant formaat.'
                    },
                    action: {
                        type: 'array',
                        items: { type: 'object' },
                        description: 'Lijst van acties in Home Assistant formaat (bv. service: cover.close_cover, target: { entity_id: cover.living }).'
                    },
                    mode: {
                        type: 'string',
                        enum: ['single', 'restart', 'queued', 'parallel'],
                        description: 'Uitvoeringsmodus (standaard single).'
                    }
                },
                required: ['alias', 'trigger', 'action']
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
                action: { ...action, result: 'success', executedLocally: true } as any
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
                action: { ...action, result: 'success', executedLocally: true } as any
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
// 6. Energy & Spot Prices Tool Implementation
// -------------------------------------------------------------
async function executeEnergyPricesTool(
    args: any,
    options: { devices?: HADevice[]; haUrl?: string; haToken?: string }
): Promise<any> {
    let allStates: any[] = options.devices || [];

    // If device list is empty, fetch directly via HA REST API if credentials exist
    if (allStates.length === 0 && options.haUrl && options.haToken) {
        try {
            const res = await fetch(`${options.haUrl.replace(/\/+$/, '')}/api/states`, {
                headers: {
                    'Authorization': `Bearer ${options.haToken}`,
                    'Content-Type': 'application/json'
                }
            });
            if (res.ok) {
                const fetched = await res.json();
                if (Array.isArray(fetched)) allStates = fetched;
            }
        } catch (e: any) {
            logger.warn('[ClientOrchestrator] HA REST states fetch error for energy prices:', e.message);
        }
    }

    // 1. Check for active Home Assistant spot price sensors (Nordpool, ENTSO-E, EPEX Spot, Tibber, Frank Energie, etc.)
    let priceSensor: any = null;
    let detectedProvider = 'Home Assistant';

    if (args.device_or_sensor) {
        priceSensor = allStates.find(s => s.entity_id === args.device_or_sensor);
    }

    if (!priceSensor && allStates.length > 0) {
        const candidates = allStates.filter(s => {
            const id = (s.entity_id || '').toLowerCase();
            const fn = (s.attributes?.friendly_name || '').toLowerCase();
            const uom = (s.attributes?.unit_of_measurement || '').toLowerCase();
            return (
                id.includes('nordpool') ||
                id.includes('entsoe') ||
                id.includes('epex') ||
                id.includes('tibber') ||
                id.includes('frank_energie') ||
                id.includes('energyzero') ||
                id.includes('amber') ||
                id.includes('stroomprijs') ||
                id.includes('spotprijs') ||
                id.includes('electricity_price') ||
                fn.includes('stroomprijs') ||
                fn.includes('nordpool') ||
                fn.includes('spotprijs') ||
                uom.includes('/kwh') ||
                uom.includes('/mwh') ||
                s.attributes?.today ||
                s.attributes?.raw_today ||
                s.attributes?.prices
            );
        });

        priceSensor = candidates.find(s => s.entity_id.includes('nordpool')) ||
            candidates.find(s => s.entity_id.includes('entsoe')) ||
            candidates.find(s => s.entity_id.includes('epex')) ||
            candidates.find(s => s.entity_id.includes('tibber')) ||
            candidates.find(s => s.entity_id.includes('frank_energie')) ||
            candidates.find(s => s.entity_id.includes('energyzero')) ||
            candidates.find(s => s.entity_id.includes('price') || s.entity_id.includes('prijs')) ||
            candidates[0];

        if (priceSensor) {
            if (priceSensor.entity_id.includes('nordpool')) detectedProvider = 'Nordpool';
            else if (priceSensor.entity_id.includes('entsoe')) detectedProvider = 'ENTSO-E';
            else if (priceSensor.entity_id.includes('epex')) detectedProvider = 'EPEX Spot';
            else if (priceSensor.entity_id.includes('tibber')) detectedProvider = 'Tibber';
            else if (priceSensor.entity_id.includes('frank_energie')) detectedProvider = 'Frank Energie';
            else if (priceSensor.entity_id.includes('energyzero')) detectedProvider = 'EnergyZero';
        }
    }

    if (priceSensor) {
        const unit = priceSensor.attributes?.unit_of_measurement || '€/kWh';
        const currentPrice = parseFloat(priceSensor.state);
        const hourly: Array<{ hour: string; price: number }> = [];

        if (Array.isArray(priceSensor.attributes?.today)) {
            priceSensor.attributes.today.forEach((p: any, idx: number) => {
                const val = typeof p === 'number' ? p : parseFloat(p);
                if (!isNaN(val)) hourly.push({ hour: `${idx.toString().padStart(2, '0')}:00`, price: Number(val.toFixed(4)) });
            });
        } else if (Array.isArray(priceSensor.attributes?.raw_today)) {
            priceSensor.attributes.raw_today.forEach((item: any) => {
                const hour = item.start ? new Date(item.start).getHours() : hourly.length;
                const val = typeof item.value === 'number' ? item.value : parseFloat(item.value);
                if (!isNaN(val)) hourly.push({ hour: `${hour.toString().padStart(2, '0')}:00`, price: Number(val.toFixed(4)) });
            });
        } else if (priceSensor.attributes?.prices && typeof priceSensor.attributes.prices === 'object') {
            Object.entries(priceSensor.attributes.prices).forEach(([ts, p]: [string, any]) => {
                const hour = new Date(ts).getHours();
                const val = typeof p === 'number' ? p : parseFloat(p);
                if (!isNaN(val)) hourly.push({ hour: `${hour.toString().padStart(2, '0')}:00`, price: Number(val.toFixed(4)) });
            });
        }

        const tomorrowHourly: Array<{ hour: string; price: number }> = [];
        if (Array.isArray(priceSensor.attributes?.tomorrow)) {
            priceSensor.attributes.tomorrow.forEach((p: any, idx: number) => {
                const val = typeof p === 'number' ? p : parseFloat(p);
                if (!isNaN(val)) tomorrowHourly.push({ hour: `${idx.toString().padStart(2, '0')}:00`, price: Number(val.toFixed(4)) });
            });
        }

        const currentHour = new Date().getHours();
        const effectiveCurrentPrice = !isNaN(currentPrice)
            ? currentPrice
            : (hourly[currentHour]?.price ?? priceSensor.attributes?.current_price ?? 0);

        let average = priceSensor.attributes?.average;
        if (typeof average !== 'number' && hourly.length > 0) {
            average = Number((hourly.reduce((s, h) => s + h.price, 0) / hourly.length).toFixed(4));
        }

        const sorted = [...hourly].sort((a, b) => a.price - b.price);

        return {
            source: `Home Assistant (${priceSensor.entity_id}) - ${detectedProvider}`,
            entity_id: priceSensor.entity_id,
            friendly_name: priceSensor.attributes?.friendly_name || priceSensor.entity_id,
            unit,
            current_hour: `${currentHour.toString().padStart(2, '0')}:00`,
            current_price: Number(effectiveCurrentPrice.toFixed(4)),
            average_price_today: average,
            min_price_today: priceSensor.attributes?.min ?? sorted[0]?.price,
            max_price_today: priceSensor.attributes?.max ?? sorted[sorted.length - 1]?.price,
            cheapest_hours_today: sorted.slice(0, 3),
            most_expensive_hours_today: sorted.slice(-3).reverse(),
            is_cheap_now: typeof average === 'number' ? effectiveCurrentPrice <= average : true,
            hourly_prices_today: hourly,
            tomorrow_prices_available: tomorrowHourly.length > 0,
            hourly_prices_tomorrow: tomorrowHourly
        };
    }

    // 2. Fallback: Live Day-Ahead EPEX Spot Market Feed (EnergyZero public API)
    try {
        const today = new Date().toISOString().slice(0, 10);
        const res = await fetch(`https://api.energyzero.nl/v1/energyprices?fromDate=${today}T00:00:00.000Z&tillDate=${today}T23:59:59.999Z&interval=4`);
        if (res.ok) {
            const data = await res.json();
            const prices: any[] = data.Prices || [];
            if (prices.length > 0) {
                const currentHour = new Date().getHours();
                const currentItem = prices.find(p => new Date(p.readingDate).getHours() === currentHour) || prices[0];
                const hourly = prices.map(p => ({
                    hour: `${new Date(p.readingDate).getHours().toString().padStart(2, '0')}:00`,
                    price: Number(p.price.toFixed(4))
                }));

                const sorted = [...hourly].sort((a, b) => a.price - b.price);
                const avg = Number((hourly.reduce((s, h) => s + h.price, 0) / hourly.length).toFixed(4));

                let tomorrowPrices: any[] = [];
                try {
                    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
                    const tomRes = await fetch(`https://api.energyzero.nl/v1/energyprices?fromDate=${tomorrow}T00:00:00.000Z&tillDate=${tomorrow}T23:59:59.999Z&interval=4`);
                    if (tomRes.ok) {
                        const tomData = await tomRes.json();
                        if (Array.isArray(tomData.Prices) && tomData.Prices.length > 0) {
                            tomorrowPrices = tomData.Prices.map((p: any) => ({
                                hour: `${new Date(p.readingDate).getHours().toString().padStart(2, '0')}:00`,
                                price: Number(p.price.toFixed(4))
                            }));
                        }
                    }
                } catch { }

                return {
                    source: 'Live Day-Ahead Spotmarkt (EPEX Spot)',
                    note: 'Live spotprijzen opgehaald via de openbare EPEX Spotmarkt feed (BE/NL). Koppel eventueel Nordpool of ENTSO-E in Home Assistant voor leveranciers-specifieke toeslagen.',
                    unit: '€/kWh',
                    current_hour: `${currentHour.toString().padStart(2, '0')}:00`,
                    current_price: Number(currentItem?.price.toFixed(4)),
                    average_price_today: avg,
                    min_price_today: sorted[0]?.price,
                    max_price_today: sorted[sorted.length - 1]?.price,
                    cheapest_hours_today: sorted.slice(0, 3),
                    most_expensive_hours_today: sorted.slice(-3).reverse(),
                    is_cheap_now: currentItem?.price <= avg,
                    hourly_prices_today: hourly,
                    tomorrow_prices_available: tomorrowPrices.length > 0,
                    hourly_prices_tomorrow: tomorrowPrices
                };
            }
        }
    } catch (e: any) {
        logger.error('[ClientOrchestrator] Spot market fallback error:', e);
    }

    return {
        error: 'Kon actuele stroomprijzen niet ophalen uit Home Assistant of live spotmarkt.',
        hint: 'Installeer of activeer de Nordpool of ENTSO-E integratie in Home Assistant.'
    };
}

// -------------------------------------------------------------
// 7. Get Entity State & Attributes Tool Implementation
// -------------------------------------------------------------
async function executeGetEntityStateTool(
    args: any,
    options: { devices?: HADevice[]; haUrl?: string; haToken?: string }
): Promise<any> {
    const query = (args.entity_id_or_search || '').toLowerCase().trim();
    let allStates: any[] = options.devices || [];

    if (allStates.length === 0 && options.haUrl && options.haToken) {
        try {
            const res = await fetch(`${options.haUrl.replace(/\/+$/, '')}/api/states`, {
                headers: {
                    'Authorization': `Bearer ${options.haToken}`,
                    'Content-Type': 'application/json'
                }
            });
            if (res.ok) {
                const fetched = await res.json();
                if (Array.isArray(fetched)) allStates = fetched;
            }
        } catch { }
    }

    if (allStates.length === 0) {
        return { error: 'Geen apparaten of sensoren gevonden in Home Assistant context.' };
    }

    const exact = allStates.find(s => s.entity_id.toLowerCase() === query);
    if (exact) {
        return {
            entity_id: exact.entity_id,
            friendly_name: exact.attributes?.friendly_name || exact.entity_id,
            state: exact.state,
            unit: exact.attributes?.unit_of_measurement || null,
            attributes: exact.attributes,
            last_changed: exact.last_changed
        };
    }

    const matches = allStates.filter(s =>
        s.entity_id.toLowerCase().includes(query) ||
        (s.attributes?.friendly_name && s.attributes.friendly_name.toLowerCase().includes(query))
    ).slice(0, 8);

    if (matches.length > 0) {
        return {
            found_count: matches.length,
            matches: matches.map(m => ({
                entity_id: m.entity_id,
                friendly_name: m.attributes?.friendly_name || m.entity_id,
                state: m.state,
                unit: m.attributes?.unit_of_measurement || null,
                attributes: m.attributes
            }))
        };
    }

    return { message: `Geen entiteit gevonden in Home Assistant die overeenkomt met "${query}".` };
}

// -------------------------------------------------------------
// 7. Extended Tool Execution Handlers (History, Logbook, Camera, Todo, Calendar, Automation)
// -------------------------------------------------------------
async function executeHistoryTool(
    args: any,
    options: { haUrl?: string; haToken?: string }
): Promise<any> {
    const { entity_id, hours_ago = 24 } = args;
    if (!options.haUrl || !options.haToken) {
        return { error: 'Home Assistant API URL en token zijn niet beschikbaar voor geschiedenis.' };
    }
    try {
        return await fetchHAHistory(options.haUrl, options.haToken, entity_id, hours_ago);
    } catch (e: any) {
        return { error: `Geschiedenis ophalen mislukt voor ${entity_id}: ${e.message}` };
    }
}

async function executeLogbookTool(
    args: any,
    options: { haUrl?: string; haToken?: string }
): Promise<any> {
    const { entity_id, hours_ago = 24 } = args;
    if (!options.haUrl || !options.haToken) {
        return { error: 'Home Assistant API URL en token zijn niet beschikbaar voor het logboek.' };
    }
    try {
        return await fetchHALogbook(options.haUrl, options.haToken, entity_id, hours_ago);
    } catch (e: any) {
        return { error: `Logboek ophalen mislukt: ${e.message}` };
    }
}

async function executeCameraSnapshotTool(
    args: any,
    options: { haUrl?: string; haToken?: string }
): Promise<any> {
    const { camera_entity_id, question } = args;
    if (!options.haUrl || !options.haToken) {
        return { error: 'Home Assistant API URL en token zijn niet beschikbaar voor camerabeelden.' };
    }
    try {
        const snap = await fetchHACameraSnapshot(options.haUrl, options.haToken, camera_entity_id);
        return {
            camera_entity_id,
            question,
            has_image: true,
            snapshot_data_url: snap.dataUrl,
            status: 'Camerabeeld succesvol opgehaald. Beeld is klaar voor weergave en analyse.'
        };
    } catch (e: any) {
        return { error: `Camerabeeld ophalen mislukt van ${camera_entity_id}: ${e.message}` };
    }
}

async function executeTodoListTool(
    args: any,
    options: { haUrl?: string; haToken?: string }
): Promise<any> {
    const { action, item_summary, list_entity_id } = args;
    if (!options.haUrl || !options.haToken) {
        return { error: 'Home Assistant API URL en token zijn niet beschikbaar voor to-do lijsten.' };
    }
    try {
        if (action === 'list') {
            return await fetchHATodoItems(options.haUrl, options.haToken, list_entity_id);
        } else {
            if (!item_summary) {
                return { error: `Item tekst ontbreekt voor actie "${action}".` };
            }
            let targetList = list_entity_id;
            if (!targetList) {
                const listInfo = await fetchHATodoItems(options.haUrl, options.haToken);
                targetList = (listInfo as any)?.list_entity_id || 'todo.shopping_list';
            }
            return await manageHATodoItem(options.haUrl, options.haToken, action, {
                listEntityId: targetList,
                item: item_summary,
                status: action === 'complete' ? 'completed' : 'needs_action'
            });
        }
    } catch (e: any) {
        return { error: `To-do actie "${action}" mislukt: ${e.message}` };
    }
}

async function executeCalendarEventsTool(
    args: any,
    options: { haUrl?: string; haToken?: string }
): Promise<any> {
    const { calendar_entity_id, days_ahead = 7 } = args;
    if (!options.haUrl || !options.haToken) {
        return { error: 'Home Assistant API URL en token zijn niet beschikbaar voor kalenders.' };
    }
    try {
        return await fetchHACalendarEvents(options.haUrl, options.haToken, calendar_entity_id, days_ahead);
    } catch (e: any) {
        return { error: `Kalender-evenementen ophalen mislukt: ${e.message}` };
    }
}

function executeCreateAutomationTool(args: any): any {
    const { alias, description, trigger, condition, action, mode = 'single' } = args;
    const autoId = `butler_${Date.now()}`;
    return {
        id: autoId,
        alias,
        description: description || `Aangemaakt door Butler op ${new Date().toLocaleString('nl-BE')}`,
        trigger: Array.isArray(trigger) ? trigger : [trigger],
        condition: condition ? (Array.isArray(condition) ? condition : [condition]) : [],
        action: Array.isArray(action) ? action : [action],
        mode,
        ready_for_user_review: true,
        message: `Automatisering "${alias}" is ontworpen en klaargezet voor goedkeuring.`
    };
}

/** SOTA On-Demand Search Tool for Home Assistant Entities */
async function executeSearchEntitiesTool(
    args: any,
    options: { devices: HADevice[]; haUrl?: string; haToken?: string }
): Promise<any> {
    const { query = '', room = '', domain = '' } = args;
    const qLower = query.toLowerCase();
    const rLower = room.toLowerCase();
    const dLower = domain.toLowerCase();

    let pool = options.devices;
    if (pool.length === 0 && options.haUrl && options.haToken) {
        try {
            const { getHAStates } = await import('../../utils/home-assistant');
            pool = await getHAStates(options.haUrl, options.haToken);
        } catch { }
    }

    const matches = pool.filter(d => {
        const eid = d.entity_id.toLowerCase();
        const fname = (d.attributes?.friendly_name || '').toLowerCase();
        const dDomain = eid.split('.')[0];

        if (dLower && dDomain !== dLower) return false;
        if (rLower && !eid.includes(rLower) && !fname.includes(rLower)) return false;
        if (qLower && !eid.includes(qLower) && !fname.includes(qLower)) return false;

        return true;
    }).slice(0, 10);

    if (matches.length > 0) {
        return {
            found_count: matches.length,
            entities: matches.map(m => ({
                entity_id: m.entity_id,
                friendly_name: m.attributes?.friendly_name || m.entity_id,
                state: m.state,
                unit: m.attributes?.unit_of_measurement || null
            }))
        };
    }

    return { message: `Geen apparaten gevonden voor zoekcriteria (zoekterm: "${query}", ruimte: "${room}", domein: "${domain}").` };
}

// -------------------------------------------------------------
// 8. SOTA Semantic & Spatial Context Pre-Filtering
// -------------------------------------------------------------
interface EntityFilterResult {
    topologySummary: string;
    relevantEntitiesSection: string;
    matchedCount: number;
}

export function filterContextEntities(
    userMessage: string,
    devices: HADevice[]
): EntityFilterResult {
    const rawTopo = typeof localStorage !== 'undefined' ? localStorage.getItem('ha_topology_latest') : null;
    let topo: any = null;
    try {
        if (rawTopo) topo = JSON.parse(rawTopo);
    } catch { }

    const deviceMap = new Map(devices.map(d => [d.entity_id, d]));
    const roomToDevices = new Map<string, HADevice[]>();

    // 1. Build a super-compact Tier 1 House Structure Map (Summary only, ZERO device bloat!)
    let topologySummary = '';
    if (topo && Array.isArray(topo.areas)) {
        const floorLines: string[] = [];
        if (Array.isArray(topo.floors) && topo.floors.length > 0) {
            topo.floors.forEach((f: any) => {
                const floorAreas = (f.areas || []).map((areaId: string) => topo.areas.find((a: any) => a.id === areaId)).filter(Boolean);
                if (floorAreas.length > 0) {
                    const areaSummary = floorAreas.map((ar: any) => {
                        const areaDevs = (ar.entities || []).map((eid: string) => deviceMap.get(eid)).filter(Boolean);
                        roomToDevices.set(ar.name.toLowerCase(), areaDevs);
                        roomToDevices.set(ar.id.toLowerCase(), areaDevs);
                        return `${ar.name} (${areaDevs.length} app)`;
                    }).join(', ');
                    floorLines.push(`  - Verdieping '${f.name}': ${areaSummary}`);
                }
            });
        } else {
            const areaSummary = topo.areas.map((ar: any) => {
                const areaDevs = (ar.entities || []).map((eid: string) => deviceMap.get(eid)).filter(Boolean);
                roomToDevices.set(ar.name.toLowerCase(), areaDevs);
                roomToDevices.set(ar.id.toLowerCase(), areaDevs);
                return `${ar.name} (${areaDevs.length} app)`;
            }).join(', ');
            floorLines.push(`  - Ruimtes: ${areaSummary}`);
        }
        if (floorLines.length > 0) {
            topologySummary = `### HUISSTRUCTUUR (OVERZICHT RUIMTES & VERDIEPINGEN):\n${floorLines.join('\n')}\n`;
        }
    }

    const lowerMsg = userMessage.toLowerCase();

    // 2. Intent Detection: Pure external questions require ZERO devices in prompt!
    const isPureWeather = /weer|regen|temperatuur buiten|wind|storm|zonnig|onweer|dauwpunt|paraplu/i.test(lowerMsg) &&
        !/woon|living|slaap|keuken|bad|lamp|licht|thermostaat|verwarming|rolluik|stekker/i.test(lowerMsg);

    const isPureNavigation = /hoe lang rijden|reistijd|route naar|afstand tot|navigeer/i.test(lowerMsg);
    const isPureMemory = /onthoud dat|mijn voorkeur is|vergeet dat/i.test(lowerMsg);
    const isPureTodo = /boodschappen|to-do|takenlijst|zet .* op .*lijst|vink .* af/i.test(lowerMsg) && !/lamp|licht|verwarming/i.test(lowerMsg);
    const isPureCalendar = /afvalkalender|restafval|pmd|papier|wanneer.*opgehaald|agenda vandaag|afspraken/i.test(lowerMsg);
    const isPureSpotPrices = /stroomprijs|energieprijs|spotprijs|dynamisch tarief|dynamische tarieven|uurprijs/i.test(lowerMsg) &&
        !/wasmachine|droogkast|laden|auto|schakel|aan|uit/i.test(lowerMsg);

    if (isPureWeather || isPureNavigation || isPureMemory || isPureTodo || isPureCalendar || isPureSpotPrices) {
        return {
            topologySummary,
            relevantEntitiesSection: 'Geen apparaten nodig voor deze vraag.',
            matchedCount: 0
        };
    }

    // 3. Smart Home Query: Semantic Pre-Filtering
    const matchedRooms: string[] = [];
    roomToDevices.forEach((_, roomKey) => {
        if (lowerMsg.includes(roomKey)) {
            matchedRooms.push(roomKey);
        }
    });

    const mentionsBoven = /boven|verdieping|1e verdieping|slaapkamer|badkamer/i.test(lowerMsg);
    const mentionsBeneden = /beneden|gelijkvloers|keuken|living|woonkamer|salon/i.test(lowerMsg);

    const domains: string[] = [];
    if (/licht|lamp|spot|spots|verlichting|peertje|schemerlamp/i.test(lowerMsg)) domains.push('light');
    if (/thermostaat|verwarm|temperatuur|graden|airco|koel|hvac/i.test(lowerMsg)) domains.push('climate');
    if (/schakelaar|stopcontact|stekker|koffie|switch/i.test(lowerMsg)) domains.push('switch');
    if (/rolluik|gordijn|zonwering|screen|blind|shutter|poort|garage/i.test(lowerMsg)) domains.push('cover');
    if (/muziek|radio|speaker|box|tv|volume|spelen|sonos|media/i.test(lowerMsg)) domains.push('media_player');
    if (/slot|deur|grendel|lock/i.test(lowerMsg)) domains.push('lock');
    if (/stofzuiger|stofzuig|vacuum/i.test(lowerMsg)) domains.push('vacuum');
    if (/batterij|accu|solar|zonnepaneel|zonnepanelen|opwek|verbruik|kwh/i.test(lowerMsg)) domains.push('sensor');

    const scored = devices.map(d => {
        let score = 0;
        const eid = d.entity_id.toLowerCase();
        const fname = (d.attributes?.friendly_name || '').toLowerCase();
        const domain = eid.split('.')[0];

        if (domains.includes(domain)) score += 8;

        for (const room of matchedRooms) {
            if (eid.includes(room) || fname.includes(room)) score += 15;
            const devsInRoom = roomToDevices.get(room) || [];
            if (devsInRoom.some(rDev => rDev.entity_id === d.entity_id)) score += 15;
        }

        if (mentionsBoven && (/slaap|bad|overloop|zolder|boven/i.test(eid) || /slaap|bad|overloop|zolder|boven/i.test(fname))) score += 10;
        if (mentionsBeneden && (/woon|living|keuken|hal|gang|garage|tuin|beneden/i.test(eid) || /woon|living|keuken|hal|gang|garage|tuin|beneden/i.test(fname))) score += 10;

        const words = lowerMsg.split(/\s+/).filter(w => w.length > 2);
        for (const w of words) {
            if (fname.includes(w) || eid.includes(w)) score += 12;
        }

        if (/wat staat.*aan|welke.*aan|wat brandt/i.test(lowerMsg) && d.state === 'on') score += 10;

        return { device: d, score };
    });

    scored.sort((a, b) => b.score - a.score);
    let candidates = scored.filter(s => s.score > 0);

    if (candidates.length === 0) {
        if (/alles.*uit|alles.*aan/i.test(lowerMsg)) {
            candidates = scored.filter(s => ['light', 'switch'].includes(s.device.entity_id.split('.')[0]));
        } else {
            candidates = scored.filter(s => s.device.state === 'on' || /climate|energy|solar/i.test(s.device.entity_id));
        }
    }

    const selected = candidates.slice(0, 15).map(s => s.device);

    const relevantDevicesText = selected.map(d => {
        const name = d.attributes?.friendly_name || d.entity_id;
        const uom = d.attributes?.unit_of_measurement ? ` ${d.attributes.unit_of_measurement}` : '';
        return `${d.entity_id} (${name}): ${d.state}${uom}`;
    }).join('\n');

    return {
        topologySummary,
        relevantEntitiesSection: relevantDevicesText || 'Geen actieve apparaten direct gerelateerd aan de vraag. Gebruik search_home_entities om apparaten op te zoeken.',
        matchedCount: selected.length
    };
}

// -------------------------------------------------------------
// 9. SOTA Dynamic System Prompt Builder
// -------------------------------------------------------------
function buildSystemPrompt(options: ClientOrchestratorOptions): string {
    const { language, location, devices, userMessage } = options;
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('nl-BE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // SOTA Pre-filtering: Only inject the 0-12 entities that actually matter
    const filterRes = filterContextEntities(userMessage, devices);

    // Retrieve stored core memories
    const storedMems = getStoredMemories().map(m => `- ${m.content}`).join('\n') || '- Geen specifieke voorkeuren opgeslagen.';

    const locationContext = location
        ? `Coördinaten: ${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}`
        : 'Locatie: Thuisbasis (zone.home)';

    return `Je bent Butler, de intelligente, betrouwbare persoonlijke AI-assistent voor Home Assistant en het dagelijks leven.
Je draait direct op het apparaat van de gebruiker met state-of-the-art ReAct tool calling en minimale token-belasting.

### HUIDIGE CONTEXT:
- Datum & Tijd: ${dateStr}, ${timeStr}
- Huidige Locatie: ${locationContext}
- Taal van de gebruiker: ${language} (Antwoord ALTIJD in het Nederlands, behalve als de gebruiker expliciet in een andere taal spreekt)

${filterRes.topologySummary}
### GESELECTEERDE RELEVANTE APPARATEN VOOR DEZE VRAAG (${filterRes.matchedCount} geselecteerd uit ${devices.length} totaal):
${filterRes.relevantEntitiesSection}

### DYNAMISCH CORE GEHEUGEN (Letta / Memori):
${storedMems}

### STRIKTE REGELS VOOR HET GEBRUIK VAN TOOLS:
1. **NOOIT GISSEN NAAR WEER OF DATA**: Vraagt de gebruiker naar het weer, regen, temperatuur, wind of dauwpunt? Roep **ALTIJD** \`get_weather\` aan.
2. **DAUWPUNT & WINDSNELHEID**: Vermeld bij wind de snelheid en stoten in km/h. Vermeld bij luchtvochtigheid ook het dauwpunt.
3. **STROOM- EN SPOTPRIJZEN**: Vraagt de gebruiker naar stroomprijs, 24u-spotprijzen, dynamische tarieven of goedkope uren? Roep **ALTIJD** \`get_energy_prices\` aan.
4. **HISTORIEK & STATISTIEKEN (ZONNEPANELEN, VERBRUIK, VERLEDEN)**: Vraagt de gebruiker hoeveel stroom er gisteren/vorige week is opgewekt/verbruikt of wat de minimum/maximum temperatuur was? Roep **ALTIJD** \`get_ha_history_and_statistics\` aan.
5. **LOGBOEK & GEBEURTENISSEN**: Vraagt de gebruiker wanneer iets gebeurde of wie iets deed? Gebruik \`get_ha_logbook\`.
6. **CAMERABEELDEN & DEURBEL**: Vraagt de gebruiker wie er voor de deur staat of wat er op camera te zien is? Roep **ALTIJD** \`capture_camera_snapshot\` aan.
7. **TO-DO & BOODSCHAPPEN**: Voor boodschappen en takenlijsten (bekijken, toevoegen, afvinken), gebruik \`manage_todo_list\`.
8. **KALENDER & AFVALKALENDER**: Voor afvalophaaldagen of afspraken, gebruik \`get_calendar_events\`.
9. **AUTOMATISERINGEN ONTWERPEN**: Als de gebruiker een automatisering wil aanmaken, gebruik \`create_home_assistant_automation\`.
10. **ON-DEMAND APPARATEN ZOEKEN**: Als een gewenst apparaat niet in de bovenstaande selectie staat of de vraag breed is (bv. "zoek de rolluiken"), roep dan \`search_home_entities\` aan om gericht entiteiten te vinden.
11. **APPARAATBEDIENING**: Gebruik \`control_home_device\` om apparaten aan te sturen met domein, service en entity_id.
12. **COMMUNICATIESTIJL**: Wees behulpzaam, vlot, natuurlijk en to-the-point. Geen overbodige meta-tekst ("Ik ga nu een tool aanroepen..."). Geef direct het juiste antwoord na afhandeling van de tools.`;
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
                        data: toolResult,
                        result: 'success',
                        executedLocally: true
                    });
                } else if (fnName === 'get_energy_prices') {
                    toolResult = await executeEnergyPricesTool(fnArgs, {
                        devices: options.devices,
                        haUrl: options.haUrl,
                        haToken: options.haToken
                    });
                    actionsTaken.push({
                        type: 'energy',
                        entity_id: 'sensor.energy_prices',
                        service: 'energy.get_prices',
                        data: toolResult,
                        result: 'success',
                        executedLocally: true
                    });
                } else if (fnName === 'get_entity_state') {
                    toolResult = await executeGetEntityStateTool(fnArgs, {
                        devices: options.devices,
                        haUrl: options.haUrl,
                        haToken: options.haToken
                    });
                } else if (fnName === 'control_home_device') {
                    const devRes = await executeDeviceControl(fnArgs, {
                        haWebSocket: options.haWebSocket,
                        haUrl: options.haUrl,
                        haToken: options.haToken
                    });
                    toolResult = devRes;
                    actionsTaken.push({
                        ...devRes.action,
                        result: devRes.success ? 'success' : 'error',
                        executedLocally: true
                    });
                } else if (fnName === 'manage_core_memory') {
                    toolResult = executeCoreMemoryTool(fnArgs);
                } else if (fnName === 'get_navigation_eta') {
                    toolResult = await executeNavigationTool(fnArgs, options.location);
                    actionsTaken.push({
                        type: 'navigation',
                        entity_id: 'device.navigation',
                        service: 'navigation.eta',
                        data: toolResult,
                        result: 'success',
                        executedLocally: true
                    });
                } else if (fnName === 'get_ha_history_and_statistics') {
                    toolResult = await executeHistoryTool(fnArgs, {
                        haUrl: options.haUrl,
                        haToken: options.haToken
                    });
                    actionsTaken.push({
                        type: 'history',
                        entity_id: fnArgs.entity_id,
                        service: 'history.period',
                        data: toolResult,
                        result: 'success',
                        executedLocally: true
                    });
                } else if (fnName === 'get_ha_logbook') {
                    toolResult = await executeLogbookTool(fnArgs, {
                        haUrl: options.haUrl,
                        haToken: options.haToken
                    });
                    actionsTaken.push({
                        type: 'logbook',
                        entity_id: fnArgs.entity_id || 'logbook',
                        service: 'logbook.get_events',
                        data: toolResult,
                        result: 'success',
                        executedLocally: true
                    });
                } else if (fnName === 'capture_camera_snapshot') {
                    toolResult = await executeCameraSnapshotTool(fnArgs, {
                        haUrl: options.haUrl,
                        haToken: options.haToken
                    });
                    actionsTaken.push({
                        type: 'camera',
                        entity_id: fnArgs.camera_entity_id,
                        service: 'camera.snapshot',
                        data: toolResult,
                        result: toolResult?.has_image ? 'success' : 'error',
                        executedLocally: true
                    });
                } else if (fnName === 'manage_todo_list') {
                    toolResult = await executeTodoListTool(fnArgs, {
                        haUrl: options.haUrl,
                        haToken: options.haToken
                    });
                    actionsTaken.push({
                        type: 'todo',
                        entity_id: fnArgs.list_entity_id || 'todo.shopping_list',
                        service: `todo.${fnArgs.action}`,
                        data: toolResult,
                        result: 'success',
                        executedLocally: true
                    });
                } else if (fnName === 'get_calendar_events') {
                    toolResult = await executeCalendarEventsTool(fnArgs, {
                        haUrl: options.haUrl,
                        haToken: options.haToken
                    });
                    actionsTaken.push({
                        type: 'calendar',
                        entity_id: fnArgs.calendar_entity_id || 'calendar.default',
                        service: 'calendar.get_events',
                        data: toolResult,
                        result: 'success',
                        executedLocally: true
                    });
                } else if (fnName === 'search_home_entities') {
                    toolResult = await executeSearchEntitiesTool(fnArgs, {
                        devices: options.devices,
                        haUrl: options.haUrl,
                        haToken: options.haToken
                    });
                } else if (fnName === 'create_home_assistant_automation') {
                    toolResult = executeCreateAutomationTool(fnArgs);
                    actionsTaken.push({
                        type: 'automation',
                        entity_id: toolResult.id,
                        service: 'automation.create',
                        data: toolResult,
                        result: 'pending',
                        executedLocally: true
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
