/**
 * Client-Side SOTA Unified ReAct Orchestrator (v2.0)
 *
 * Single unified agent with:
 * - Centralized Model Registry & automatic failover (never breaks on retired models)
 * - Gemini 3.8 Flash / Gemini 4 Hydrogen API compliance (reasoning_effort, no deprecated temperature)
 * - Parallel tool calling (Promise.all) for sub-2s multi-action latency
 * - True multimodal vision for Home Assistant camera snapshots
 * - Direct local Home Assistant WebSocket/REST execution + On-demand Proactive Backend Workers
 * - Zero hardcoded intent-blanking regexes or synthetic fallback sentences
 */

import { logger } from '../../utils/logger';
import { Action, HADevice, LLMResponse } from '../../types';
import { callHAService, buildHAUrl, sanitizeHAToken, fetchWithTimeout } from '../../utils/home-assistant';
import {
    fetchHAHistory,
    fetchHALogbook,
    fetchHACameraSnapshot,
    fetchHATodoItems,
    manageHATodoItem,
    fetchHACalendarEvents
} from '../../utils/ha-api';
import { supabase } from '../supabase';
import {
    AIProvider,
    AIResolvedConfig,
    DEFAULT_GEMINI_MODEL,
    DEFAULT_OPENROUTER_MODEL,
    GOOGLE_GEMINI_API_URL,
    OPENROUTER_API_URL,
    sanitizeModelId,
    resolveAIConfig,
    getEscalationModels,
    supportsTemperatureParam,
    supportsReasoningEffort
} from './modelRegistry';
import { triggerProactiveWorker, ProactiveWorkerId } from './proactiveWorkers';
import {
    setPhoneFlashlight,
    setPhoneVolume,
    setPhoneRingerMode,
    getPhoneBatteryStatus,
    openPhoneApp,
    openTurnByTurnNavigation,
    openExternalUrl,
    communicateWithContact
} from './deviceControlService';
import {
    executeCookingAssistant,
    getActiveRecipeSession
} from './cookingService';
import {
    listGoogleCalendarEvents,
    createGoogleCalendarEvent,
    updateGoogleCalendarEvent,
    deleteGoogleCalendarEvent,
    manageGoogleDocs,
    manageGoogleSheets,
    manageGoogleTasks,
    manageGmail,
    controlSpotify,
    searchYouTubeVideos
} from './googleWorkspaceService';

export {
    GOOGLE_GEMINI_API_URL,
    OPENROUTER_API_URL,
    DEFAULT_GEMINI_MODEL,
    DEFAULT_OPENROUTER_MODEL,
    sanitizeModelId,
    resolveAIConfig
};
export type { AIProvider, AIResolvedConfig };

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
// 1. Unified Tool Schemas (OpenAI / Gemini / OpenRouter Compatible)
// -------------------------------------------------------------
const ORCHESTRATOR_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Haalt actuele weersomstandigheden, 24-uurs uurlijkse neerslag/temperatuur en 3-daagse voorspelling op (incl. gevoelstemperatuur, dauwpunt, wind & windstoten).',
            parameters: {
                type: 'object',
                properties: {
                    location_name: { type: 'string', description: 'Plaatsnaam of stad (optioneel; standaard huidige locatie).' },
                    latitude: { type: 'number', description: 'Optionele breedtegraad.' },
                    longitude: { type: 'number', description: 'Optionele lengtegraad.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'google_search',
            description: 'Zoekt live op internet via Google Search (met actuele bronnen) naar publieke informatie die niet in Home Assistant staat, zoals Belgische/Nederlandse brandstof- en dieselprijzen vandaag/morgen/gisteren, nieuws, verkeer, openingsuren, sportuitslagen, koersen, recepten of recente feiten.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Concrete zoekvraag in de juiste taal/regio (bv. "maximumprijs diesel B7 België morgen vandaag gisteren FOD Economie").' },
                    region: { type: 'string', description: 'Optionele regio of land (bv. "België", "Nederland"). Standaard afgeleid van de taal van de gebruiker.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'control_home_device',
            description: 'Bestuurt een apparaat, entiteit of integratie-service in Home Assistant (light, switch, select, button, number, climate, media_player, cover, lock, fan, vacuum, scene, script, of aangepaste integraties zoals localthings).',
            parameters: {
                type: 'object',
                properties: {
                    domain: { type: 'string', description: 'Home Assistant domein of integratie (bv. light, switch, select, button, number, climate, media_player, cover, lock, scene, script, localthings).' },
                    service: { type: 'string', description: 'Service naam zonder domeinprefix (bv. turn_on, turn_off, toggle, select_option, press, set_value, set_temperature, open_cover).' },
                    entity_id: { type: 'string', description: 'Optionele exacte Home Assistant entity_id (bv. light.woonkamer). Laat weg bij integratie-brede services zonder target entity.' },
                    parameters: { type: 'object', description: 'Optionele service parameters (bv. brightness_pct, option, value, temperature, color_name).' }
                },
                required: ['domain', 'service']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_home_entities',
            description: 'Zoekt gericht naar apparaten, sensoren, keuzes of knoppen in Home Assistant op trefwoord, kamernaam, domein of integratie (bv. "localthings", "hue", "zigbee2mqtt", "shelly"). Roep met lege filters aan voor een volledig overzicht van alle integraties en apparaten.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Zoekterm of naam (bv. "leeslamp", "droogkast", "wasmachine", "localthings", "stroomprijs").' },
                    room: { type: 'string', description: 'Optionele kamernaam (bv. "woonkamer", "keuken", "wasplaats").' },
                    domain: { type: 'string', description: 'Optioneel HA-domein (bv. "light", "switch", "select", "button", "number", "sensor", "climate", "cover", "camera", "todo").' },
                    integration: { type: 'string', description: 'Optionele HA-integratie / platform (bv. "localthings", "hue", "esphome", "zigbee2mqtt", "shelly").' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_entity_state',
            description: 'Leest de actuele status en alle attributen uit van een specifieke Home Assistant entiteit of sensor.',
            parameters: {
                type: 'object',
                properties: {
                    entity_id_or_search: { type: 'string', description: 'Exacte entity_id of zoekterm.' }
                },
                required: ['entity_id_or_search']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_energy_prices',
            description: 'Haalt actuele en komende dynamische elektriciteits- of gasprijzen (vandaag & morgen, daggemiddelde, goedkoopste/duurste uren) op uit Home Assistant of live EPEX/EnergyZero spotmarkt.',
            parameters: {
                type: 'object',
                properties: {
                    device_or_sensor: { type: 'string', description: 'Optionele specifieke HA sensor entity_id.' },
                    energy_type: { type: 'string', enum: ['electricity', 'gas'], description: 'electricity (standaard) of gas.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_ha_history_and_statistics',
            description: 'Haalt historische data en statistieken (min, max, gemiddelde, verschil/delta, statuswisselingen) op van een Home Assistant entiteit over de afgelopen uren of dagen.',
            parameters: {
                type: 'object',
                properties: {
                    entity_id: { type: 'string', description: 'Exacte Home Assistant entity_id.' },
                    hours_ago: { type: 'number', description: 'Aantal uren terug (standaard 24, max 720).' }
                },
                required: ['entity_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_ha_logbook',
            description: 'Leest recente gebeurtenissen en tijdstippen uit het Home Assistant logboek (bv. wie/wanneer deur geopend of beweging gedetecteerd).',
            parameters: {
                type: 'object',
                properties: {
                    entity_id: { type: 'string', description: 'Optionele entity_id om op te filteren.' },
                    hours_ago: { type: 'number', description: 'Aantal uren terug (standaard 24).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'capture_camera_snapshot',
            description: 'Maakt een live snapshot van een Home Assistant camera of deurbel zodat je het beeld direct visueel kunt analyseren en beschrijven.',
            parameters: {
                type: 'object',
                properties: {
                    camera_entity_id: { type: 'string', description: 'Exacte camera entity_id (bv. camera.voordeur).' }
                },
                required: ['camera_entity_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'manage_todo_list',
            description: 'Beheert to-do lijsten en boodschappenlijsten in zowel Home Assistant (todo.*) als Google Tasks (bekijken, enkel item of hele ingrediëntenlijst in één keer toevoegen, afvinken, verwijderen).',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'add', 'add_many', 'complete', 'remove', 'list_lists'], description: 'De actie op de lijst (gebruik add_many voor meerdere boodschappen/ingrediënten tegelijk).' },
                    source: { type: 'string', enum: ['auto', 'ha', 'google'], description: 'Doelsysteem: auto (standaard: HA todo indien beschikbaar, anders Google Tasks), ha (Home Assistant), of google (Google Tasks).' },
                    item: { type: 'string', description: 'Naam van één item (vereist bij add/complete/remove).' },
                    items: { type: 'array', items: { type: 'string' }, description: 'Lijst van items (vereist bij add_many, bv. alle ingrediënten van een recept).' },
                    list_entity_id: { type: 'string', description: 'Optionele Home Assistant todo entity_id (bv. todo.shopping_list).' },
                    list_id: { type: 'string', description: 'Optionele Google Tasks lijst-ID (standaard @default).' },
                    due_date: { type: 'string', description: 'Optionele vervaldatum ISO (voor Google Tasks).' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'manage_calendar',
            description: 'Beheert agenda en afspraken over zowel Home Assistant kalenders als Google Calendar: afspraken bekijken (combineert beide bronnen), of nieuwe afspraken aanmaken, aanpassen en verwijderen in Google Calendar.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Actie: list (bekijk HA + Google Calendar), create, update of delete (Google Calendar).' },
                    days_ahead: { type: 'number', description: 'Aantal dagen vooruit bij action="list" (standaard 7, max 90).' },
                    calendar_entity_id: { type: 'string', description: 'Optionele specifieke Home Assistant kalender entity_id bij action="list".' },
                    summary: { type: 'string', description: 'Titel van de afspraak (bij create/update).' },
                    start_time: { type: 'string', description: 'Lokale starttijd in ISO-formaat zonder Z, bv. "2026-11-24T14:30:00" (bij create/update).' },
                    duration_minutes: { type: 'number', description: 'Duur in minuten (standaard 60, bij create/update).' },
                    location: { type: 'string', description: 'Optionele locatie van de afspraak.' },
                    description: { type: 'string', description: 'Optionele notities/omschrijving.' },
                    event_id: { type: 'string', description: 'Google Calendar event_id (vereist bij update/delete; haal eerst op met action="list").' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'control_phone',
            description: 'Bedient hardware, systeeminstellingen en apps rechtstreeks op de Android-telefoon van de gebruiker: zaklamp (aan/uit/toggle), mediavolume/belvolume/alarmvolume, geluidsmodus (normaal/trillen/stil), batterijstatus uitlezen, apps openen (Spotify, YouTube, Maps, WhatsApp, Docs, Sheets, Instellingen, Wi-Fi, Bluetooth) of een web-URL openen.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['flashlight', 'volume', 'ringer_mode', 'battery', 'open_app', 'open_url'],
                        description: 'Welke telefoonfunctie je wilt uitvoeren.'
                    },
                    flashlight_mode: { type: 'string', enum: ['on', 'off', 'toggle'], description: 'Bij action="flashlight": on, off of toggle.' },
                    volume_stream: { type: 'string', enum: ['media', 'ring', 'alarm', 'notification', 'call'], description: 'Bij action="volume": welk geluidskanaal (standaard media).' },
                    volume_percent: { type: 'number', description: 'Bij action="volume": exact percentage 0-100.' },
                    volume_direction: { type: 'string', enum: ['up', 'down', 'mute'], description: 'Bij action="volume": relatief harder, zachter of dempen.' },
                    ringer_mode: { type: 'string', enum: ['normal', 'vibrate', 'silent'], description: 'Bij action="ringer_mode": normaal, trillen of stil.' },
                    app_name: { type: 'string', description: 'Bij action="open_app": bv. spotify, youtube, maps, whatsapp, gmail, calendar, docs, sheets, drive, waze, settings, wifi, bluetooth.' },
                    query: { type: 'string', description: 'Optionele zoekterm bij open_app (bv. voor YouTube, Spotify of Maps).' },
                    url: { type: 'string', description: 'Bij action="open_url": de te openen https:// URL.' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cooking_assistant',
            description: 'Interactieve stap-voor-stap kookassistent met blijvende kooksessie, automatisch scherm-aan houden, porties herschalen en ingebouwde kooktimers. Gebruik start_recipe zodra de gebruiker een gerecht stap voor stap wil koken; gebruik next_step/previous_step/repeat_step/goto_step/scale_servings/list_ingredients/finish_recipe tijdens het koken.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['start_recipe', 'next_step', 'previous_step', 'goto_step', 'repeat_step', 'get_status', 'list_ingredients', 'scale_servings', 'finish_recipe'],
                        description: 'Kookactie.'
                    },
                    title: { type: 'string', description: 'Naam van het gerecht (vereist bij start_recipe).' },
                    servings: { type: 'number', description: 'Aantal personen (bij start_recipe of scale_servings).' },
                    prep_time: { type: 'string', description: 'Optionele voorbereidingstijd (bv. "15 min").' },
                    cook_time: { type: 'string', description: 'Optionele kooktijd (bv. "25 min").' },
                    ingredients: { type: 'array', items: { type: 'string' }, description: 'Volledige ingrediëntenlijst met hoeveelheden (vereist bij start_recipe).' },
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                instruction: { type: 'string', description: 'Duidelijke, beknopte kookinstructie voor deze stap.' },
                                timer_minutes: { type: 'number', description: 'Optionele kook-/baktijd in minuten voor deze stap.' },
                                tip: { type: 'string', description: 'Optionele korte chef-tip.' }
                            },
                            required: ['instruction']
                        },
                        description: 'Stappenlijst voor het recept (vereist bij start_recipe; maak heldere, korte spreekbare stappen).'
                    },
                    step_number: { type: 'number', description: 'Doelstap (1-gebaseerd, bij goto_step).' },
                    source_url: { type: 'string', description: 'Optionele bron-URL van het recept.' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'manage_google_docs',
            description: 'Zoekt, leest, maakt aan en bewerkt Google Docs-documenten (tekst toevoegen of zoeken & vervangen).',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'read', 'create', 'append', 'replace_text'], description: 'Actie op Google Docs.' },
                    document_id: { type: 'string', description: 'Google Docs ID (optioneel als title/query gegeven is).' },
                    query: { type: 'string', description: 'Zoekterm om documenten te vinden.' },
                    title: { type: 'string', description: 'Titel van het document (bij create of zoeken).' },
                    content: { type: 'string', description: 'Tekstinhoud (bij create of append).' },
                    find_text: { type: 'string', description: 'Te zoeken tekst (bij replace_text).' },
                    replace_with: { type: 'string', description: 'Vervangende tekst (bij replace_text).' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'manage_google_sheets',
            description: 'Zoekt, leest, maakt aan en bewerkt Google Sheets-spreadsheets (rijen toevoegen of celbereik bijwerken; herkent automatisch Blad1/Sheet1).',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'read', 'create', 'append_rows', 'update_range'], description: 'Actie op Google Sheets.' },
                    spreadsheet_id: { type: 'string', description: 'Google Spreadsheet ID (optioneel als title/query gegeven is).' },
                    query: { type: 'string', description: 'Zoekterm voor spreadsheetnaam.' },
                    title: { type: 'string', description: 'Naam van nieuwe of te zoeken spreadsheet.' },
                    range: { type: 'string', description: 'Optioneel bereik zoals "Blad1!A1:D10" (leeg = automatisch eerste tabblad).' },
                    values: {
                        type: 'array',
                        items: { type: 'array', items: { type: 'string' } },
                        description: '2D array van rijen/cellen (bv. [["Datum","Item","Bedrag"],["2026-11-23","Boodschappen","45,50"]]).'
                    }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'manage_email',
            description: 'Beheert Gmail van de gebruiker: ongelezen e-mails ophalen, zoeken, volledige e-mail lezen of een e-mail versturen.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list_unread', 'search', 'read', 'send'], description: 'Gmail actie.' },
                    query: { type: 'string', description: 'Gmail zoekterm (bij search, bv. "from:bol.com" of "factuur").' },
                    message_id: { type: 'string', description: 'E-mail ID (bij read).' },
                    to: { type: 'string', description: 'Ontvanger e-mailadres (bij send).' },
                    subject: { type: 'string', description: 'Onderwerp (bij send).' },
                    body: { type: 'string', description: 'Berichttekst (bij send).' },
                    limit: { type: 'number', description: 'Max aantal e-mails (standaard 5).' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'control_media_services',
            description: 'Bedient Spotify (status, afspelen/zoeken, pauze, volgende, vorige, volume — met automatische app-fallback als er geen actief Spotify Connect apparaat is) en start of zoekt video\'s op YouTube. Gebruik bij YouTube command="play" (of "open") om de beste video direct te starten en af te spelen in de YouTube-app; gebruik command="search" enkel als de gebruiker expliciet een keuzelijst vraagt.',
            parameters: {
                type: 'object',
                properties: {
                    service: { type: 'string', enum: ['spotify', 'youtube'], description: 'Mediadienst.' },
                    command: { type: 'string', enum: ['status', 'play', 'pause', 'next', 'previous', 'volume', 'search', 'open'], description: 'Commando (Spotify: status/play/pause/next/previous/volume; YouTube: play/open om direct af te spelen, search voor alleen een lijst).' },
                    query: { type: 'string', description: 'Nummer, artiest, playlist of video-zoekterm.' },
                    volume_percent: { type: 'number', description: 'Spotify volume 0-100 (bij command="volume").' },
                    open_directly: { type: 'boolean', description: 'True om YouTube/Spotify direct op de telefoon te openen en te starten.' }
                },
                required: ['service', 'command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'communicate_with_contact',
            description: 'Zoekt automatisch een contact op in het telefoonboek van de gebruiker en opent WhatsApp, SMS, Line of de telefoondialer met het vooraf ingevulde nummer/bericht.',
            parameters: {
                type: 'object',
                properties: {
                    channel: { type: 'string', enum: ['whatsapp', 'sms', 'call', 'line'], description: 'Kanaal: whatsapp, sms, call (belt via dialer) of line.' },
                    contact_name: { type: 'string', description: 'Naam van het contact om op te zoeken (bv. "Mama", "Jan").' },
                    phone: { type: 'string', description: 'Optioneel direct telefoonnummer.' },
                    message: { type: 'string', description: 'Berichttekst (voor whatsapp, sms of line).' }
                },
                required: ['channel']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_home_assistant_automation',
            description: 'Ontwerpt een volledige Home Assistant automatisering (alias, trigger, condition, action) die de gebruiker met één klik kan activeren.',
            parameters: {
                type: 'object',
                properties: {
                    alias: { type: 'string', description: 'Naam van de automatisering.' },
                    description: { type: 'string', description: 'Korte uitleg.' },
                    trigger: { type: 'array', items: { type: 'object' }, description: 'Lijst van HA triggers.' },
                    condition: { type: 'array', items: { type: 'object' }, description: 'Optionele HA voorwaarden.' },
                    action: { type: 'array', items: { type: 'object' }, description: 'Lijst van HA acties.' },
                    mode: { type: 'string', enum: ['single', 'restart', 'queued', 'parallel'], description: 'Uitvoeringsmodus (standaard single).' }
                },
                required: ['alias', 'trigger', 'action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'manage_core_memory',
            description: 'Beheert het langetermijngeheugen over voorkeuren, gewoontes en feiten van de gebruiker.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['get', 'save', 'delete'], description: 'Lezen, opslaan of verwijderen.' },
                    content: { type: 'string', description: 'Het op te slaan feit of de voorkeur.' },
                    memory_id: { type: 'string', description: 'ID of trefwoord om te verwijderen.' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_navigation_eta',
            description: 'Berekent echte wegafstand en reistijd via OSRM wegennet-routing (auto, fiets, te voet) inclusief aankomsttijd en Google Maps routelink. Kan optioneel ook direct turn-by-turn navigatie op de telefoon starten.',
            parameters: {
                type: 'object',
                properties: {
                    destination: { type: 'string', description: 'Bestemming (adres, stad of POI).' },
                    origin: { type: 'string', description: 'Optioneel vertrekpunt (indien leeg wordt de live GPS-locatie gebruikt).' },
                    mode: { type: 'string', enum: ['driving', 'walking', 'bicycling'], description: 'Vervoersmiddel (standaard driving).' },
                    start_navigation: { type: 'boolean', description: 'Zet op true als de gebruiker expliciet vraagt om direct te navigeren / Google Maps te starten.' }
                },
                required: ['destination']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_timer_or_alarm',
            description: 'Stelt een wekker of afteltimer in op de telefoon van de gebruiker.',
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['timer', 'alarm'], description: 'timer of alarm.' },
                    duration_seconds: { type: 'number', description: 'Aantal seconden (voor timer, bv. 600 voor 10 minuten).' },
                    hour: { type: 'number', description: 'Uur 0-23 (voor alarm).' },
                    minute: { type: 'number', description: 'Minuut 0-59 (voor alarm).' },
                    label: { type: 'string', description: 'Optioneel label of bericht.' }
                },
                required: ['kind']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_graph',
            description: 'Maakt en opent een interactieve historische grafiek voor één of meer Home Assistant sensoren.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Titel van de grafiek.' },
                    entity_ids: { type: 'array', items: { type: 'string' }, description: 'Lijst van sensor entity_ids om te plotten.' },
                    period: { type: 'string', enum: ['1h', '6h', '24h', '7d', '30d'], description: 'Tijdsperiode (standaard 24h).' }
                },
                required: ['title', 'entity_ids']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_proactive_worker',
            description: 'Voert direct een proactieve Butler-achtergrondworker uit op aanvraag (ochtendbriefing, patroonanalyse, anomaliedetectie, energieplanning, gewoontes/klimaat/laadsnelheid leren, dagelijkse check).',
            parameters: {
                type: 'object',
                properties: {
                    worker: {
                        type: 'string',
                        enum: ['morning-briefing', 'daily-butler', 'analyze-patterns', 'detect-anomalies', 'energy-scheduler', 'learn-climate', 'learn-energy', 'learn-habits'],
                        description: 'Naam van de uit te voeren proactieve worker.'
                    },
                    extra_params: { type: 'object', description: 'Optionele extra parameters voor de worker.' }
                },
                required: ['worker']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'consult_deep_reasoner',
            description: 'Schakelt een krachtiger redeneermodel in voor complexe taken die dieper denkwerk, hoge precisie of meerstaps-logica vereisen (zoals ingewikkelde Home Assistant-automatiseringen ontwerpen, diepe data-/energie-analyse, programmeren, debugging, financiële/wiskundige berekeningen of strategische planning). Gebruik deze tool NIET voor simpele dagelijkse commando\'s zoals lampen schakelen, weer, timers of korte feiten.',
            parameters: {
                type: 'object',
                properties: {
                    task: {
                        type: 'string',
                        description: 'De volledige, heldere taak of complexe vraag om diep over na te denken.'
                    },
                    context: {
                        type: 'string',
                        description: 'Alle relevante reeds opgehaalde feiten, sensorwaarden, entity_ids, prijzen of voorkeuren.'
                    },
                    depth: {
                        type: 'string',
                        enum: ['medium', 'high'],
                        description: 'medium = Gemini 4 Hydrogen (hoge nauwkeurigheid, analyses, vergelijkingen, advies); high = Gemini 4 Argon (diep redeneren, complexe YAML/automatiseringen, wiskunde, programmeren, debugging).'
                    }
                },
                required: ['task', 'depth']
            }
        }
    }
];

// -------------------------------------------------------------
// 2. Weather Tool (Open-Meteo — preserves hourly & 3-day forecasts!)
// -------------------------------------------------------------
function getWmoDescription(code: number): string {
    const map: Record<number, string> = {
        0: 'Helder', 1: 'Licht bewolkt', 2: 'Gedeeltelijk bewolkt', 3: 'Geheel bewolkt',
        45: 'Mist', 48: 'Aanvriezende mist',
        51: 'Lichte motregen', 53: 'Matige motregen', 55: 'Dichte motregen',
        61: 'Lichte regen', 63: 'Matige regen', 65: 'Zware regen',
        71: 'Lichte sneeuw', 73: 'Matige sneeuw', 75: 'Zware sneeuw',
        80: 'Lichte regenbuien', 81: 'Matige regenbuien', 82: 'Zware regenbuien',
        95: 'Onweer', 96: 'Onweer met lichte hagel', 99: 'Onweer met zware hagel'
    };
    return map[code] || 'Wisselend bewolkt';
}

async function executeWeatherTool(args: any, userLocation?: { lat: number; lon: number } | null): Promise<any> {
    let lat = typeof args.latitude === 'number' ? args.latitude : userLocation?.lat;
    let lon = typeof args.longitude === 'number' ? args.longitude : userLocation?.lon;
    let resolvedLocationName = args.location_name || (userLocation ? 'Huidige locatie' : 'Brussel (standaard)');

    if (args.location_name && (typeof args.latitude !== 'number' || typeof args.longitude !== 'number')) {
        try {
            const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(args.location_name)}&limit=1`;
            const geoRes = await fetchWithTimeout(geoUrl, {}, 8000);
            if (geoRes.ok) {
                const geoData = await geoRes.json();
                if (Array.isArray(geoData) && geoData.length > 0) {
                    lat = parseFloat(geoData[0].lat);
                    lon = parseFloat(geoData[0].lon);
                    resolvedLocationName = geoData[0].display_name.split(',')[0];
                }
            }
        } catch (e) {
            logger.warn('[ClientOrchestrator] Geocoding failed:', e);
        }
    }

    if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) {
        lat = 50.8503;
        lon = 4.3517;
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,dew_point_2m&hourly=temperature_2m,precipitation_probability,precipitation,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&timezone=auto&forecast_days=3`;

    const res = await fetchWithTimeout(url, {}, 10000);
    if (!res.ok) {
        return { error: `Weer-API fout (${res.status}).` };
    }
    const data = await res.json();
    const cur = data.current || {};
    const daily = data.daily || {};
    const hourly = data.hourly || {};

    // Next 24 hours from current hour
    const nowMs = Date.now();
    const hourlyNext24h: Array<{ time: string; temp_c: number; rain_prob_pct: number; precip_mm: number; condition: string }> = [];
    if (Array.isArray(hourly.time)) {
        for (let i = 0; i < hourly.time.length && hourlyNext24h.length < 24; i++) {
            const tMs = new Date(hourly.time[i]).getTime();
            if (tMs >= nowMs - 3600000) {
                hourlyNext24h.push({
                    time: hourly.time[i].slice(11, 16),
                    temp_c: hourly.temperature_2m?.[i],
                    rain_prob_pct: hourly.precipitation_probability?.[i] ?? 0,
                    precip_mm: hourly.precipitation?.[i] ?? 0,
                    condition: getWmoDescription(hourly.weather_code?.[i] ?? 0)
                });
            }
        }
    }

    const forecastDays: Array<any> = [];
    if (Array.isArray(daily.time)) {
        for (let i = 0; i < daily.time.length; i++) {
            forecastDays.push({
                date: daily.time[i],
                condition: getWmoDescription(daily.weather_code?.[i] ?? 0),
                temp_max_c: daily.temperature_2m_max?.[i],
                temp_min_c: daily.temperature_2m_min?.[i],
                precipitation_sum_mm: daily.precipitation_sum?.[i],
                rain_probability_max_pct: daily.precipitation_probability_max?.[i],
                wind_max_kmh: daily.wind_speed_10m_max?.[i]
            });
        }
    }

    return {
        location: { name: resolvedLocationName, lat, lon },
        current: {
            temperature: cur.temperature_2m,
            temperature_c: cur.temperature_2m,
            feels_like_c: cur.apparent_temperature,
            dew_point: cur.dew_point_2m,
            dew_point_c: cur.dew_point_2m,
            relative_humidity: cur.relative_humidity_2m,
            wind_speed: cur.wind_speed_10m,
            wind_speed_kmh: cur.wind_speed_10m,
            wind_gusts: cur.wind_gusts_10m,
            wind_gusts_kmh: cur.wind_gusts_10m,
            precipitation: cur.precipitation,
            precipitation_mm: cur.precipitation,
            cloud_cover_pct: cur.cloud_cover,
            weather_description: getWmoDescription(cur.weather_code ?? 0),
            condition_nl: getWmoDescription(cur.weather_code ?? 0),
            is_day: cur.is_day === 1
        },
        hourly_next_24h: hourlyNext24h,
        forecast_today: forecastDays[0] || null,
        forecast_3_days: forecastDays
    };
}

// -------------------------------------------------------------
// 3. Home Assistant Device Control Tool (instant WS if connected, else REST)
// -------------------------------------------------------------
async function executeDeviceControl(
    args: any,
    options: { haWebSocket?: any; haUrl?: string; haToken?: string }
): Promise<{ success: boolean; message: string; action: Action }> {
    let domain = (args.domain || '').trim().toLowerCase();
    let service = (args.service || '').trim().toLowerCase();
    const entity_id = (args.entity_id || '').trim();
    const parameters = args.parameters || {};

    // Handle LLM passing "light.turn_on" as service
    if (service.includes('.')) {
        const parts = service.split('.');
        if (!domain) domain = parts[0];
        service = parts[1];
    }
    if (!domain && entity_id.includes('.')) {
        domain = entity_id.split('.')[0];
    }

    const serviceData: Record<string, any> = {
        ...parameters,
        ...(entity_id ? { entity_id } : {})
    };

    const targetLabel = entity_id || `${domain}.${service}`;

    const actionRecord: Action = {
        type: domain || 'homeassistant',
        entity_id: entity_id || undefined,
        service: `${domain}.${service}`,
        data: parameters,
        executedLocally: true
    };

    // Only use WebSocket when ALREADY connected & authenticated (never block 10s on offline WS!)
    if (options.haWebSocket && typeof options.haWebSocket.isConnected === 'function' && options.haWebSocket.isConnected()) {
        try {
            await options.haWebSocket.sendMessage({
                type: 'call_service',
                domain,
                service,
                service_data: serviceData
            }, 6000);
            return {
                success: true,
                message: `Service ${domain}.${service} uitgevoerd op ${targetLabel} via WebSocket.`,
                action: { ...actionRecord, result: 'success' }
            };
        } catch (wsErr: any) {
            logger.warn('[ClientOrchestrator] WS device control failed, falling back to REST:', wsErr?.message);
        }
    }

    if (options.haUrl && options.haToken) {
        try {
            await callHAService(domain, service, serviceData, options.haUrl, options.haToken);
            return {
                success: true,
                message: `Service ${domain}.${service} uitgevoerd op ${targetLabel} via REST.`,
                action: { ...actionRecord, result: 'success' }
            };
        } catch (restErr: any) {
            return {
                success: false,
                message: `Fout bij uitvoeren van ${domain}.${service} op ${targetLabel}: ${restErr?.message || restErr}`,
                action: { ...actionRecord, result: 'error', error_message: restErr?.message }
            };
        }
    }

    return {
        success: false,
        message: 'Geen actieve Home Assistant verbinding beschikbaar.',
        action: { ...actionRecord, result: 'error', error_message: 'No HA connection' }
    };
}

// -------------------------------------------------------------
// 4. Core Memory Tool (localStorage + real Supabase `user_memories` sync)
// -------------------------------------------------------------
const CORE_MEMORY_KEY = 'butler_core_memories_v2';

function getStoredMemories(): Array<{ id: string; content: string; created_at: string }> {
    try {
        const raw = localStorage.getItem(CORE_MEMORY_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function saveMemoryItem(content: string, connectionId?: string) {
    const items = getStoredMemories();
    const newItem = { id: `mem_${Date.now()}`, content, created_at: new Date().toISOString() };
    items.push(newItem);
    try {
        localStorage.setItem(CORE_MEMORY_KEY, JSON.stringify(items.slice(-50)));
    } catch { }

    // Sync to real `user_memories` table (columns: connection_id, category, content)
    if (connectionId) {
        try {
            const { error } = await supabase.from('user_memories').insert({
                connection_id: connectionId,
                category: 'core_preference',
                content
            });
            if (error) {
                logger.warn('[ClientOrchestrator] Supabase user_memories sync error:', error.message);
            }
        } catch { }
    }
    return newItem;
}

async function deleteMemoryItem(idOrKeyword: string, connectionId?: string): Promise<boolean> {
    const items = getStoredMemories();
    const lower = (idOrKeyword || '').toLowerCase().trim();
    if (!lower) return false;
    const filtered = items.filter(m => m.id !== idOrKeyword && !m.content.toLowerCase().includes(lower));
    try {
        localStorage.setItem(CORE_MEMORY_KEY, JSON.stringify(filtered));
    } catch { }

    if (connectionId) {
        try {
            const safePattern = lower.replace(/[%_]/g, '');
            if (safePattern.length >= 2) {
                await supabase
                    .from('user_memories')
                    .delete()
                    .eq('connection_id', connectionId)
                    .ilike('content', `%${safePattern}%`);
            }
        } catch { }
    }

    return filtered.length < items.length;
}

async function executeCoreMemoryTool(args: any, connectionId?: string): Promise<any> {
    if (args.action === 'get') {
        const localMems = getStoredMemories();
        if (connectionId) {
            try {
                const { data } = await supabase
                    .from('user_memories')
                    .select('id, content, created_at')
                    .eq('connection_id', connectionId)
                    .order('created_at', { ascending: false })
                    .limit(30);
                if (Array.isArray(data) && data.length > 0) {
                    const seen = new Set(localMems.map(m => m.content));
                    const merged = [...localMems, ...data.filter(d => !seen.has(d.content))];
                    return { memories: merged };
                }
            } catch { }
        }
        return { memories: localMems };
    }
    if (args.action === 'save' && args.content) {
        const saved = await saveMemoryItem(args.content, connectionId);
        return { status: 'saved', memory: saved };
    }
    if (args.action === 'delete' && args.memory_id) {
        const deleted = await deleteMemoryItem(args.memory_id, connectionId);
        return { status: deleted ? 'deleted' : 'not_found' };
    }
    return { error: 'Ongeldige geheugenactie.' };
}

// -------------------------------------------------------------
// 5. Navigation & ETA Tool (mode-aware speeds + honest geocode failure)
// -------------------------------------------------------------
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodePlace(query: string): Promise<{ lat: number; lon: number; displayName: string } | null> {
    try {
        const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
        const geoRes = await fetchWithTimeout(geoUrl, {}, 8000);
        if (!geoRes.ok) return null;
        const geoData = await geoRes.json();
        if (Array.isArray(geoData) && geoData.length > 0) {
            return {
                lat: parseFloat(geoData[0].lat),
                lon: parseFloat(geoData[0].lon),
                displayName: geoData[0].display_name
            };
        }
    } catch (e: any) {
        logger.warn('[ClientOrchestrator] Geocode error:', e?.message);
    }
    return null;
}

async function executeNavigationTool(args: any, userLocation?: { lat: number; lon: number } | null): Promise<any> {
    const dest = (args.destination || '').trim();
    if (!dest) return { error: 'Geen bestemming opgegeven.' };

    const mode: 'driving' | 'walking' | 'bicycling' =
        ['driving', 'walking', 'bicycling'].includes(args.mode) ? args.mode : 'driving';

    const customOrigin = (args.origin || '').trim();
    const mapsUrl = customOrigin
        ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(customOrigin)}&destination=${encodeURIComponent(dest)}&travelmode=${mode}`
        : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=${mode}`;

    let originLat = userLocation?.lat ?? 50.8503;
    let originLon = userLocation?.lon ?? 4.3517;
    let originLabel = userLocation ? 'Huidige locatie' : 'Brussel (standaard)';
    let usedFallbackOrigin = !userLocation;

    if (customOrigin) {
        const origGeo = await geocodePlace(customOrigin);
        if (origGeo) {
            originLat = origGeo.lat;
            originLon = origGeo.lon;
            originLabel = origGeo.displayName;
            usedFallbackOrigin = false;
        }
    }

    let navigationLaunched = false;
    if (args.start_navigation === true) {
        const navRes = await openTurnByTurnNavigation(dest, mode);
        navigationLaunched = !!navRes.success;
    }

    const destGeo = await geocodePlace(dest);
    if (!destGeo) {
        return {
            found: false,
            navigation_launched: navigationLaunched,
            error: `Bestemming "${dest}" niet gevonden via OpenStreetMap geocoding.`,
            url: mapsUrl,
            maps_url: mapsUrl
        };
    }

    // Real road routing via OSRM (zero API key, exact road distance & driving/bike/foot duration)
    let distanceKm: number | null = null;
    let durationMin: number | null = null;
    let routingEngine = 'OSRM (echte wegennet-route)';

    try {
        const osrmProfile = mode === 'walking' ? 'foot' : mode === 'bicycling' ? 'bike' : 'driving';
        const osrmUrl = `https://router.project-osrm.org/route/v1/${osrmProfile}/${originLon},${originLat};${destGeo.lon},${destGeo.lat}?overview=false`;
        const osrmRes = await fetchWithTimeout(osrmUrl, {}, 9000);
        if (osrmRes.ok) {
            const osrmData = await osrmRes.json();
            const route = osrmData?.routes?.[0];
            if (route && Number.isFinite(route.distance) && Number.isFinite(route.duration)) {
                distanceKm = Number((route.distance / 1000).toFixed(1));
                durationMin = Math.max(1, Math.round(route.duration / 60));
            }
        }
    } catch (e: any) {
        logger.warn('[ClientOrchestrator] OSRM routing fallback triggered:', e?.message);
    }

    // Graceful Haversine fallback if OSRM is temporarily unreachable
    if (distanceKm === null || durationMin === null) {
        const straightKm = haversineKm(originLat, originLon, destGeo.lat, destGeo.lon);
        const roadKm = straightKm * 1.28;
        const speedKmh = mode === 'walking' ? 5 : mode === 'bicycling' ? 16 : 60;
        distanceKm = Number(roadKm.toFixed(1));
        durationMin = Math.max(1, Math.round((roadKm / speedKmh) * 60));
        routingEngine = 'Schatting (fallback)';
    }

    const etaDate = new Date(Date.now() + durationMin * 60 * 1000);
    const etaTime = etaDate.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });

    return {
        found: true,
        routing_engine: routingEngine,
        origin: originLabel,
        destination: destGeo.displayName,
        mode,
        used_fallback_origin: usedFallbackOrigin,
        distance_km: distanceKm,
        duration_minutes: durationMin,
        eta_arrival_time: etaTime,
        navigation_launched: navigationLaunched,
        url: mapsUrl,
        maps_url: mapsUrl
    };
}

// -------------------------------------------------------------
// 6. Energy Prices Tool (HA sensors + local timezone + EnergyZero API)
// -------------------------------------------------------------
function getLocalDateBoundsIso(daysOffset = 0): { fromIso: string; tillIso: string } {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + daysOffset);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { fromIso: start.toISOString(), tillIso: end.toISOString() };
}

async function fetchEnergyZeroPrices(daysOffset: number, isGas: boolean): Promise<Array<{ hour: string; price: number }>> {
    try {
        const { fromIso, tillIso } = getLocalDateBoundsIso(daysOffset);
        // EnergyZero usageType: 1 = electricity, 3 = gas
        const usageType = isGas ? 3 : 1;
        const url = `https://api.energyzero.nl/v1/energyprices?fromDate=${encodeURIComponent(fromIso)}&tillDate=${encodeURIComponent(tillIso)}&interval=4&usageType=${usageType}&inclBtw=true`;
        const res = await fetchWithTimeout(url, {}, 8000);
        if (!res.ok) return [];
        const data = await res.json();
        if (!Array.isArray(data?.Prices)) return [];
        return data.Prices
            .map((p: any) => {
                const num = Number(p?.price);
                const d = new Date(p?.readingDate);
                if (!Number.isFinite(num) || isNaN(d.getTime())) return null;
                return {
                    hour: `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
                    price: Number(num.toFixed(4))
                };
            })
            .filter(Boolean) as Array<{ hour: string; price: number }>;
    } catch {
        return [];
    }
}

async function executeEnergyPricesTool(
    args: any,
    options: { devices?: HADevice[]; haUrl?: string; haToken?: string }
): Promise<any> {
    let allStates: any[] = options.devices || [];

    if (allStates.length === 0 && options.haUrl && options.haToken) {
        try {
            const res = await fetchWithTimeout(buildHAUrl('/api/states', options.haUrl), {
                headers: { Authorization: `Bearer ${sanitizeHAToken(options.haToken)}`, 'Content-Type': 'application/json' }
            });
            if (res.ok) {
                const fetched = await res.json();
                if (Array.isArray(fetched)) allStates = fetched;
            }
        } catch { }
    }

    const isGasQuery = args.energy_type === 'gas' || /gas|gasprijs|kuub|m³|m3/i.test(args.device_or_sensor || '');
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

            if (!isGasQuery) {
                if (id.includes('gas') || fn.includes('gas') || uom.includes('m³') || uom.includes('m3')) return false;
            } else {
                if (!id.includes('gas') && !fn.includes('gas') && !uom.includes('m³') && !uom.includes('m3')) return false;
            }

            // Require actual energy price indicator (do NOT match arbitrary sensors just because they have attributes.today!)
            const hasPriceKeyword =
                id.includes('nordpool') || id.includes('entsoe') || id.includes('epex') ||
                id.includes('tibber') || id.includes('frank_energie') || id.includes('energyzero') ||
                id.includes('amber') || id.includes('stroomprijs') || id.includes('spotprijs') ||
                id.includes('electricity_price') || id.includes('gasprijs') ||
                fn.includes('stroomprijs') || fn.includes('gasprijs') || fn.includes('spotprijs') || fn.includes('nordpool');

            const hasPriceUnit =
                (uom.includes('€') || uom.includes('eur') || uom.includes('ct')) &&
                (uom.includes('kwh') || uom.includes('mwh') || uom.includes('m³') || uom.includes('m3'));

            return hasPriceKeyword || hasPriceUnit;
        });

        if (!isGasQuery) {
            priceSensor =
                candidates.find(s => s.entity_id.includes('energyzero') && (s.entity_id.includes('energy') || s.entity_id.includes('current_hour_price'))) ||
                candidates.find(s => s.entity_id.includes('nordpool')) ||
                candidates.find(s => s.entity_id.includes('entsoe')) ||
                candidates.find(s => s.entity_id.includes('epex')) ||
                candidates.find(s => s.entity_id.includes('tibber')) ||
                candidates.find(s => s.entity_id.includes('frank_energie')) ||
                candidates.find(s => s.entity_id.includes('price') || s.entity_id.includes('prijs')) ||
                candidates[0];
        } else {
            priceSensor =
                candidates.find(s => s.entity_id.includes('energyzero') && s.entity_id.includes('gas')) ||
                candidates.find(s => s.entity_id.includes('gas')) ||
                candidates[0];
        }

        if (priceSensor) {
            const eid = priceSensor.entity_id.toLowerCase();
            if (eid.includes('nordpool')) detectedProvider = 'Nordpool';
            else if (eid.includes('entsoe')) detectedProvider = 'ENTSO-E';
            else if (eid.includes('epex')) detectedProvider = 'EPEX Spot';
            else if (eid.includes('tibber')) detectedProvider = 'Tibber';
            else if (eid.includes('frank_energie')) detectedProvider = 'Frank Energie';
            else if (eid.includes('energyzero')) detectedProvider = 'EnergyZero';
        }
    }

    const parseNumericPrice = (raw: any): number => {
        const val = typeof raw === 'number' ? raw : Number(raw);
        return Number.isFinite(val) ? val : NaN;
    };

    const currentHour = new Date().getHours();

    if (priceSensor) {
        const unit = priceSensor.attributes?.unit_of_measurement || (isGasQuery ? '€/m³' : '€/kWh');
        const currentPrice = parseNumericPrice(priceSensor.state);
        let hourly: Array<{ hour: string; price: number }> = [];

        if (Array.isArray(priceSensor.attributes?.prices)) {
            priceSensor.attributes.prices.forEach((item: any, idx: number) => {
                const val = parseNumericPrice(typeof item === 'object' ? (item?.price ?? item?.value) : item);
                const timeStr = item?.readingDate || item?.time || item?.start || item?.timestamp || item?.from;
                let hourLabel = '';
                if (timeStr) {
                    const d = new Date(timeStr);
                    if (!isNaN(d.getTime())) {
                        hourLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
                    }
                }
                if (!hourLabel) hourLabel = `${idx.toString().padStart(2, '0')}:00`;
                if (Number.isFinite(val)) hourly.push({ hour: hourLabel, price: Number(val.toFixed(4)) });
            });
        } else if (priceSensor.attributes?.prices && typeof priceSensor.attributes.prices === 'object') {
            Object.entries(priceSensor.attributes.prices).forEach(([ts, p]: [string, any]) => {
                const val = parseNumericPrice(typeof p === 'object' ? (p?.price ?? p?.value) : p);
                const d = new Date(ts);
                const hourLabel = !isNaN(d.getTime())
                    ? `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
                    : ts;
                if (Number.isFinite(val)) hourly.push({ hour: hourLabel, price: Number(val.toFixed(4)) });
            });
        } else if (Array.isArray(priceSensor.attributes?.today)) {
            priceSensor.attributes.today.forEach((p: any, idx: number) => {
                const val = parseNumericPrice(p);
                if (Number.isFinite(val)) hourly.push({ hour: `${idx.toString().padStart(2, '0')}:00`, price: Number(val.toFixed(4)) });
            });
        } else if (Array.isArray(priceSensor.attributes?.raw_today)) {
            priceSensor.attributes.raw_today.forEach((item: any, idx: number) => {
                const d = item?.start ? new Date(item.start) : null;
                const label = d && !isNaN(d.getTime())
                    ? `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
                    : `${idx.toString().padStart(2, '0')}:00`;
                const val = parseNumericPrice(item?.value ?? item?.price);
                if (Number.isFinite(val)) hourly.push({ hour: label, price: Number(val.toFixed(4)) });
            });
        }

        let tomorrowHourly: Array<{ hour: string; price: number }> = [];
        if (Array.isArray(priceSensor.attributes?.tomorrow)) {
            priceSensor.attributes.tomorrow.forEach((p: any, idx: number) => {
                const val = parseNumericPrice(p);
                if (Number.isFinite(val)) tomorrowHourly.push({ hour: `${idx.toString().padStart(2, '0')}:00`, price: Number(val.toFixed(4)) });
            });
        }

        if (hourly.length === 0) {
            hourly = await fetchEnergyZeroPrices(0, isGasQuery);
        }
        if (tomorrowHourly.length === 0 && !isGasQuery) {
            tomorrowHourly = await fetchEnergyZeroPrices(1, false);
        }

        const currentSlot = hourly.find(h => parseInt(h.hour.split(':')[0], 10) === currentHour);
        const effectiveCurrentPrice = Number.isFinite(currentPrice)
            ? currentPrice
            : (currentSlot?.price ?? parseNumericPrice(priceSensor.attributes?.current_price) ?? 0);

        const average = typeof priceSensor.attributes?.average === 'number'
            ? priceSensor.attributes.average
            : (hourly.length > 0 ? Number((hourly.reduce((s, h) => s + h.price, 0) / hourly.length).toFixed(4)) : undefined);

        const sorted = [...hourly].sort((a, b) => a.price - b.price);
        const upcomingPrices = hourly.filter(h => parseInt(h.hour.split(':')[0], 10) >= currentHour);
        if (upcomingPrices.length < 12 && tomorrowHourly.length > 0) {
            tomorrowHourly.slice(0, 12 - upcomingPrices.length).forEach(h => {
                upcomingPrices.push({ hour: `Morgen ${h.hour}`, price: h.price });
            });
        }

        return {
            source: `Home Assistant (${priceSensor.entity_id}) - ${detectedProvider}`,
            entity_id: priceSensor.entity_id,
            energy_type: isGasQuery ? 'gas' : 'electricity',
            friendly_name: priceSensor.attributes?.friendly_name || priceSensor.entity_id,
            unit,
            current_hour: `${currentHour.toString().padStart(2, '0')}:00`,
            current_price: Number((Number.isFinite(effectiveCurrentPrice) ? effectiveCurrentPrice : 0).toFixed(4)),
            average_price_today: average,
            min_price_today: priceSensor.attributes?.min ?? sorted[0]?.price,
            max_price_today: priceSensor.attributes?.max ?? sorted[sorted.length - 1]?.price,
            cheapest_hours_today: sorted.slice(0, 3),
            most_expensive_hours_today: sorted.slice(-3).reverse(),
            is_cheap_now: typeof average === 'number' ? effectiveCurrentPrice <= average : true,
            hourly_prices_today: hourly,
            upcoming_prices_next_hours: upcomingPrices,
            tomorrow_prices_available: tomorrowHourly.length > 0,
            hourly_prices_tomorrow: tomorrowHourly
        };
    }

    // Fallback: Live EnergyZero Public Spot Feed (honors gas vs electricity via usageType!)
    const [hourly, tomorrowPrices] = await Promise.all([
        fetchEnergyZeroPrices(0, isGasQuery),
        isGasQuery ? Promise.resolve([]) : fetchEnergyZeroPrices(1, false)
    ]);

    if (hourly.length > 0) {
        const currentSlot = hourly.find(h => parseInt(h.hour.split(':')[0], 10) === currentHour) || hourly[0];
        const avg = Number((hourly.reduce((s, h) => s + h.price, 0) / hourly.length).toFixed(4));
        const sorted = [...hourly].sort((a, b) => a.price - b.price);
        const upcomingPrices = hourly.filter(h => parseInt(h.hour.split(':')[0], 10) >= currentHour);
        if (upcomingPrices.length < 12 && tomorrowPrices.length > 0) {
            tomorrowPrices.slice(0, 12 - upcomingPrices.length).forEach(h => {
                upcomingPrices.push({ hour: `Morgen ${h.hour}`, price: h.price });
            });
        }

        return {
            source: 'Live Day-Ahead Spotmarkt (EnergyZero / EPEX Spot)',
            energy_type: isGasQuery ? 'gas' : 'electricity',
            unit: isGasQuery ? '€/m³' : '€/kWh',
            current_hour: `${currentHour.toString().padStart(2, '0')}:00`,
            current_price: currentSlot.price,
            average_price_today: avg,
            min_price_today: sorted[0]?.price,
            max_price_today: sorted[sorted.length - 1]?.price,
            cheapest_hours_today: sorted.slice(0, 3),
            most_expensive_hours_today: sorted.slice(-3).reverse(),
            is_cheap_now: currentSlot.price <= avg,
            hourly_prices_today: hourly,
            upcoming_prices_next_hours: upcomingPrices,
            tomorrow_prices_available: tomorrowPrices.length > 0,
            hourly_prices_tomorrow: tomorrowPrices
        };
    }

    return {
        error: `Kon actuele ${isGasQuery ? 'gas' : 'stroom'}prijzen niet ophalen uit Home Assistant of de live spotmarkt.`
    };
}

// -------------------------------------------------------------
// 7. Entity Lookup & Search Tools
// -------------------------------------------------------------
// Bilingual NL <-> EN smart-home & diagnostic search expansion (only expands recall, never hides anything)
const ENTITY_SEARCH_SYNONYMS: Record<string, string[]> = {
    wasmachine: ['washer', 'washing', 'was'],
    washer: ['wasmachine', 'washing'],
    droogkast: ['dryer', 'droger', 'tumble'],
    droger: ['dryer', 'droogkast', 'tumble'],
    dryer: ['droogkast', 'droger', 'tumble'],
    vaatwasser: ['dishwasher'],
    dishwasher: ['vaatwasser'],
    koelkast: ['fridge', 'refrigerator'],
    vriezer: ['freezer'],
    verwarming: ['climate', 'thermostat', 'heat'],
    thermostaat: ['climate', 'thermostat'],
    rolluik: ['cover', 'shutter', 'blind'],
    rolluiken: ['cover', 'shutter', 'blind'],
    gordijn: ['cover', 'curtain', 'blind'],
    gordijnen: ['cover', 'curtain', 'blind'],
    laadpaal: ['charger', 'wallbox', 'ev'],
    zonnepanelen: ['solar', 'inverter', 'omvormer', 'pv'],
    omvormer: ['inverter', 'solar'],
    deur: ['door'],
    raam: ['window'],
    lamp: ['light', 'licht'],
    lampen: ['light', 'licht'],
    licht: ['light', 'lamp'],
    lichten: ['light', 'lamp'],
    printer: ['ipp', 'brother', 'hp', 'epson', 'canon', 'toner', 'ink', 'inkt', 'cartridge', 'drum', 'page'],
    toner: ['ink', 'inkt', 'cartridge', 'drum', 'marker', 'printer', 'ipp', 'brother', 'hp', 'epson', 'canon'],
    inkt: ['ink', 'toner', 'cartridge', 'marker', 'printer', 'ipp', 'brother', 'hp', 'epson', 'canon'],
    ink: ['inkt', 'toner', 'cartridge', 'marker', 'printer', 'ipp'],
    cartridge: ['toner', 'ink', 'inkt', 'printer', 'marker'],
    drum: ['toner', 'printer', 'brother'],
    batterij: ['battery', 'accu', 'charge', 'soc'],
    battery: ['batterij', 'accu'],
    accu: ['battery', 'batterij', 'soc'],
    signaal: ['signal', 'rssi', 'linkquality', 'wifi', 'lqi'],
    wifi: ['wi-fi', 'rssi', 'signal', 'ssid', 'ip'],
    firmware: ['software', 'version', 'versie', 'update'],
    teller: ['counter', 'pages', 'page_count', 'total'],
    filter: ['filter_life', 'hepa'],
    zout: ['salt', 'dishwasher', 'vaatwasser'],
    glansspoelmiddel: ['rinse_aid', 'dishwasher', 'vaatwasser'],
    diagnostiek: ['diagnostic', 'battery', 'signal', 'rssi', 'firmware', 'uptime', 'toner', 'ink', 'error'],
    verbruik: ['power', 'energy', 'watt', 'kwh', 'consumption'],
    stroom: ['power', 'energy', 'electricity', 'watt', 'kwh']
};

const SYNONYM_KEYS = Object.keys(ENTITY_SEARCH_SYNONYMS);

function expandSearchTerms(rawQuery: string): string[] {
    const clean = (rawQuery || '').toLowerCase().trim();
    if (!clean) return [];
    const tokens = clean
        .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
    const expanded = new Set<string>([clean, ...tokens]);
    const expandToken = (tok: string) => {
        if (ENTITY_SEARCH_SYNONYMS[tok]) {
            ENTITY_SEARCH_SYNONYMS[tok].forEach(s => expanded.add(s));
        }
        // Dutch compound-word root matching: e.g. "tonerniveau" -> "toner", "batterijniveau" -> "batterij", "printerstatus" -> "printer"
        if (tok.length >= 5) {
            for (const key of SYNONYM_KEYS) {
                if (key.length >= 4 && tok.includes(key)) {
                    expanded.add(key);
                    ENTITY_SEARCH_SYNONYMS[key].forEach(s => expanded.add(s));
                }
            }
        }
    };
    for (const t of tokens) expandToken(t);
    expandToken(clean);
    return Array.from(expanded);
}

function buildDeviceSearchHaystack(d: any): string {
    const attrs = d.attributes || {};
    const attrKeys = typeof attrs === 'object' ? Object.keys(attrs).slice(0, 25).join(' ') : '';
    const extraAttrHints = [
        attrs.friendly_name,
        attrs.device_class,
        attrs.icon,
        attrs.marker_type,
        attrs.source,
        attrs.info,
        attrs.model,
        attrs.manufacturer
    ].filter(Boolean).join(' ');
    return `${d.entity_id || ''} ${d.device_name || ''} ${d.area_name || ''} ${d.manufacturer || ''} ${d.model || ''} ${d.platform || ''} ${d.entity_category || ''} ${extraAttrHints} ${attrKeys}`.toLowerCase();
}

async function executeGetEntityStateTool(
    args: any,
    options: { devices?: HADevice[]; haUrl?: string; haToken?: string }
): Promise<any> {
    const query = (args.entity_id_or_search || '').toLowerCase().trim();
    let allStates: any[] = options.devices || [];

    if (allStates.length === 0 && options.haUrl && options.haToken) {
        try {
            const res = await fetchWithTimeout(buildHAUrl('/api/states', options.haUrl), {
                headers: { Authorization: `Bearer ${sanitizeHAToken(options.haToken)}`, 'Content-Type': 'application/json' }
            });
            if (res.ok) {
                const fetched = await res.json();
                if (Array.isArray(fetched)) allStates = fetched;
            }
        } catch { }
    }

    if (allStates.length === 0) {
        return { error: 'Geen apparaten of sensoren gevonden in Home Assistant.' };
    }

    const exact = allStates.find(s => s.entity_id.toLowerCase() === query);
    if (exact) {
        return {
            entity_id: exact.entity_id,
            friendly_name: exact.attributes?.friendly_name || exact.entity_id,
            device_name: exact.device_name || undefined,
            area_name: exact.area_name || undefined,
            integration: exact.platform || undefined,
            state: exact.state,
            unit: exact.attributes?.unit_of_measurement || null,
            attributes: exact.attributes,
            last_changed: exact.last_changed
        };
    }

    const terms = expandSearchTerms(query);
    const matches = allStates
        .filter(s => {
            const hay = buildDeviceSearchHaystack(s);
            return terms.some(t => hay.includes(t));
        })
        .slice(0, 20);

    if (matches.length > 0) {
        return {
            found_count: matches.length,
            matches: matches.map(m => ({
                entity_id: m.entity_id,
                friendly_name: m.attributes?.friendly_name || m.entity_id,
                device_name: m.device_name || undefined,
                area_name: m.area_name || undefined,
                integration: m.platform || undefined,
                state: m.state,
                unit: m.attributes?.unit_of_measurement || null,
                attributes: m.attributes
            }))
        };
    }

    return { message: `Geen entiteit gevonden die overeenkomt met "${query}".` };
}

async function executeSearchEntitiesTool(
    args: any,
    options: { devices?: HADevice[]; haUrl?: string; haToken?: string; connectionId?: string }
): Promise<any> {
    const query = (args.query || '').toLowerCase().trim();
    const room = (args.room || '').toLowerCase().trim();
    const domain = (args.domain || '').toLowerCase().trim();
    const integration = (args.integration || '').toLowerCase().trim();

    let allDevices: any[] = options.devices || [];
    if (allDevices.length === 0 && options.haUrl && options.haToken) {
        try {
            const res = await fetchWithTimeout(buildHAUrl('/api/states', options.haUrl), {
                headers: { Authorization: `Bearer ${sanitizeHAToken(options.haToken)}` }
            });
            if (res.ok) allDevices = await res.json();
        } catch { }
    }

    let topoEntitiesForRoom: Set<string> | null = null;
    if (room) {
        try {
            const topoRaw = (options.connectionId && localStorage.getItem(`ha_topology_${options.connectionId}`))
                || localStorage.getItem('ha_topology_latest');
            if (topoRaw) {
                const topo = JSON.parse(topoRaw);
                const matchingAreas = (topo.areas || []).filter((a: any) =>
                    (a.name || '').toLowerCase().includes(room) || (a.id || '').toLowerCase().includes(room)
                );
                if (matchingAreas.length > 0) {
                    topoEntitiesForRoom = new Set(matchingAreas.flatMap((a: any) => a.entities || []));
                }
            }
        } catch { }
    }

    // Build active integrations summary across all entities
    const integrationStats = new Map<string, { integration: string; entity_count: number; device_names: Set<string> }>();
    for (const d of allDevices) {
        const plat = (d.platform || '').toLowerCase().trim();
        if (!plat) continue;
        if (!integrationStats.has(plat)) {
            integrationStats.set(plat, { integration: plat, entity_count: 0, device_names: new Set() });
        }
        const entry = integrationStats.get(plat)!;
        entry.entity_count += 1;
        if (d.device_name) entry.device_names.add(d.device_name);
    }
    const integrationsSummary = Array.from(integrationStats.values())
        .sort((a, b) => b.entity_count - a.entity_count)
        .map(item => ({
            integration: item.integration,
            devices: item.device_names.size,
            entities: item.entity_count
        }));

    // If user asks for a general inventory (no query, no room, no domain, no integration), return ALL integrations + up to 150 devices!
    if (!query && !room && !domain && !integration) {
        const groupedByDevice = new Map<string, {
            device_name: string;
            area_name?: string;
            integration?: string;
            entity_count: number;
            sample_entities: Array<{ entity_id: string; name: string; state: string }>;
        }>();
        const standalone: any[] = [];
        const skipDomains = new Set(['update', 'zone', 'sun', 'persistent_notification', 'tts', 'stt', 'conversation']);

        for (const d of allDevices) {
            const dom = (d.entity_id || '').split('.')[0];
            if (skipDomains.has(dom)) continue;
            if (d.device_name) {
                const key = `${d.device_name.toLowerCase()}::${(d.platform || '').toLowerCase()}`;
                if (!groupedByDevice.has(key)) {
                    groupedByDevice.set(key, {
                        device_name: d.device_name,
                        area_name: d.area_name,
                        integration: d.platform || undefined,
                        entity_count: 0,
                        sample_entities: []
                    });
                }
                const entry = groupedByDevice.get(key)!;
                entry.entity_count += 1;
                if (entry.sample_entities.length < 3) {
                    entry.sample_entities.push({
                        entity_id: d.entity_id,
                        name: d.attributes?.friendly_name || d.entity_id,
                        state: d.state
                    });
                }
            } else {
                standalone.push({
                    entity_id: d.entity_id,
                    name: d.attributes?.friendly_name || d.entity_id,
                    area_name: d.area_name,
                    integration: d.platform || undefined,
                    state: d.state
                });
            }
        }

        const allGroupedDevices = Array.from(groupedByDevice.values());
        return {
            total_entities: allDevices.length,
            total_devices: allGroupedDevices.length,
            integrations_summary: integrationsSummary,
            devices: allGroupedDevices.slice(0, 150),
            standalone_entities: standalone.slice(0, 50)
        };
    }

    const searchTerms = expandSearchTerms(query);

    const directMatches = allDevices.filter(d => {
        const eid = (d.entity_id || '').toLowerCase();
        const hay = buildDeviceSearchHaystack(d);
        const dDomain = eid.split('.')[0];
        const dPlat = (d.platform || '').toLowerCase();

        if (domain && dDomain !== domain) return false;
        if (integration && !dPlat.includes(integration) && !eid.includes(integration)) return false;
        if (room) {
            const inTopo = topoEntitiesForRoom ? topoEntitiesForRoom.has(d.entity_id) : false;
            const inArea = (d.area_name || '').toLowerCase().includes(room);
            if (!inTopo && !inArea && !hay.includes(room)) return false;
        }
        if (searchTerms.length > 0 && !searchTerms.some(t => hay.includes(t))) return false;
        return true;
    });

    // Sibling expansion: when a search matches a device (e.g. printer status, dryer, router),
    // automatically include ALL sibling entities of that device (including ALL diagnostic & config sensors!)
    const matchedDeviceIds = new Set<string>();
    const seenEntityIds = new Set<string>();
    const combinedMatches: any[] = [];
    for (const m of directMatches) {
        if (!seenEntityIds.has(m.entity_id)) {
            seenEntityIds.add(m.entity_id);
            combinedMatches.push(m);
        }
        if (m.device_id) matchedDeviceIds.add(m.device_id);
    }
    if (!domain && matchedDeviceIds.size > 0 && matchedDeviceIds.size <= 8) {
        for (const d of allDevices) {
            if (d.device_id && matchedDeviceIds.has(d.device_id) && !seenEntityIds.has(d.entity_id)) {
                seenEntityIds.add(d.entity_id);
                combinedMatches.push(d);
            }
        }
    }
    const matches = combinedMatches.slice(0, 80);

    if (matches.length === 0) {
        return {
            message: `Geen apparaten gevonden voor query="${query}", room="${room}", domain="${domain}", integration="${integration}".`,
            available_integrations: integrationsSummary.map(i => i.integration)
        };
    }

    const extractCompactAttributes = (attrs: any) => {
        if (!attrs || typeof attrs !== 'object') return undefined;
        const skipKeys = new Set(['friendly_name', 'unit_of_measurement', 'options', 'supported_features', 'supported_color_modes', 'entity_picture', 'icon', 'state_class']);
        const out: Record<string, any> = {};
        let count = 0;
        for (const [k, v] of Object.entries(attrs)) {
            if (skipKeys.has(k) || v === null || v === undefined) continue;
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
                count++;
                if (count >= 8) break;
            }
        }
        return count > 0 ? out : undefined;
    };

    return {
        found_count: matches.length,
        entities: matches.map(m => ({
            entity_id: m.entity_id,
            name: m.attributes?.friendly_name || m.entity_id,
            device_name: m.device_name || undefined,
            area_name: m.area_name || undefined,
            integration: m.platform || undefined,
            entity_category: m.entity_category || undefined,
            device_class: m.attributes?.device_class || undefined,
            state: m.state,
            unit: m.attributes?.unit_of_measurement || undefined,
            options: Array.isArray(m.attributes?.options) ? m.attributes.options : undefined,
            attributes: extractCompactAttributes(m.attributes)
        }))
    };
}

// -------------------------------------------------------------
// 8. Smart Context Selection (Clean, Bilingual, Zero Intent-Blanking Regexes!)
// -------------------------------------------------------------
const STOP_WORDS = new Set([
    'het', 'een', 'van', 'voor', 'met', 'aan', 'uit', 'wat', 'hoe', 'wie', 'waar', 'zijn', 'deze', 'naar',
    'dat', 'die', 'niet', 'ook', 'als', 'maar', 'bij', 'nog', 'wel', 'kan', 'kun', 'wil', 'aub', 'graag',
    'the', 'and', 'for', 'with', 'from', 'what', 'how', 'who', 'where', 'this', 'that', 'can', 'please', 'are'
]);

function selectInitialContextEntities(
    userMessage: string,
    devices: HADevice[],
    connectionId?: string
): { topologySummary: string; relevantEntitiesSection: string; matchedCount: number } {
    let topologySummary = '';
    const roomToDevices = new Map<string, HADevice[]>();

    try {
        const topoRaw = (connectionId && localStorage.getItem(`ha_topology_${connectionId}`))
            || localStorage.getItem('ha_topology_latest');
        if (topoRaw) {
            const topo = JSON.parse(topoRaw);
            const areasMap = new Map<string, any>();
            (topo.areas || []).forEach((a: any) => areasMap.set(a.id, a));

            const assignedAreaIds = new Set<string>();
            const lines: string[] = [];

            const indexArea = (ar: any) => {
                const areaDevs = devices.filter(d => (ar.entities || []).includes(d.entity_id));
                roomToDevices.set((ar.name || '').toLowerCase(), areaDevs);
                roomToDevices.set((ar.id || '').toLowerCase(), areaDevs);
                return `${ar.name} (${areaDevs.length})`;
            };

            if (Array.isArray(topo.floors) && topo.floors.length > 0) {
                for (const fl of topo.floors) {
                    const names: string[] = [];
                    for (const aid of (fl.areas || [])) {
                        const ar = areasMap.get(aid);
                        if (ar) {
                            assignedAreaIds.add(aid);
                            names.push(indexArea(ar));
                        }
                    }
                    if (names.length > 0) lines.push(`  - ${fl.name}: ${names.join(', ')}`);
                }
            }

            // Always include areas NOT assigned to any floor!
            const unassignedAreas = (topo.areas || []).filter((a: any) => !assignedAreaIds.has(a.id));
            if (unassignedAreas.length > 0) {
                const names = unassignedAreas.map((ar: any) => indexArea(ar));
                lines.push(`  - Overige ruimtes: ${names.join(', ')}`);
            }

            if (lines.length > 0) {
                topologySummary = `### HUISSTRUCTUUR:\n${lines.join('\n')}\n`;
            }
        }
    } catch { }

    if (!devices || devices.length === 0) {
        return {
            topologySummary,
            relevantEntitiesSection: 'Geen Home Assistant apparaten gesynchroniseerd.',
            matchedCount: 0
        };
    }

    // Tokenize cleanly (strip punctuation, filter stop-words, and expand NL<->EN + compound-word roots!)
    const lowerMsg = userMessage.toLowerCase();
    const rawTokens = lowerMsg
        .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
    const expandedTokens = new Set<string>();
    for (const t of rawTokens) {
        expandSearchTerms(t).forEach(s => {
            if (s.length >= 2 && !STOP_WORDS.has(s)) expandedTokens.add(s);
        });
    }
    const tokens = Array.from(expandedTokens);

    const matchedRooms: string[] = [];
    roomToDevices.forEach((_, roomKey) => {
        if (roomKey && roomKey.length >= 3 && lowerMsg.includes(roomKey)) {
            matchedRooms.push(roomKey);
        }
    });

    const scored = devices.map((d: any) => {
        let score = 0;
        const eid = d.entity_id.toLowerCase();
        const hay = buildDeviceSearchHaystack(d);
        const uom = (d.attributes?.unit_of_measurement || '').toLowerCase();

        for (const room of matchedRooms) {
            if (hay.includes(room)) score += 16;
            const devsInRoom = roomToDevices.get(room) || [];
            if (devsInRoom.some(rDev => rDev.entity_id === d.entity_id)) score += 16;
        }

        for (const w of tokens) {
            if (hay.includes(w)) score += 12;
            if (uom && uom.includes(w)) score += 8;
        }

        // Bilingual domain & diagnostic hints (boost, NEVER hide!)
        if (/licht|lamp|spot|light|dim/i.test(lowerMsg) && eid.startsWith('light.')) score += 6;
        if (/thermostaat|verwarm|temperatuur|graden|airco|climate|heat|temp/i.test(lowerMsg) && (eid.startsWith('climate.') || eid.includes('temperature'))) score += 6;
        if (/stroom|elektriciteit|energie|prijs|tarief|gas|spot|kwh|price|energy/i.test(lowerMsg) && (eid.includes('price') || eid.includes('prijs') || eid.includes('energy') || eid.includes('gas') || eid.includes('nordpool') || eid.includes('epex'))) score += 12;
        if (/camera|deurbel|doorbell|voordeur/i.test(lowerMsg) && eid.startsWith('camera.')) score += 12;
        if (/boodschap|todo|lijst|shopping/i.test(lowerMsg) && eid.startsWith('todo.')) score += 12;
        if (/agenda|kalender|afval|calendar/i.test(lowerMsg) && eid.startsWith('calendar.')) score += 12;
        if (/rolluik|gordijn|screen|cover|poort|garage/i.test(lowerMsg) && eid.startsWith('cover.')) score += 8;
        if (/muziek|radio|tv|sonos|speaker|volume|media/i.test(lowerMsg) && eid.startsWith('media_player.')) score += 8;
        if (/printer|toner|inkt|ink|cartridge|drum/i.test(lowerMsg) && /printer|toner|ink|cartridge|drum|ipp|brother|epson|canon|hp_/.test(hay)) score += 18;
        if (/batterij|battery|accu|signaal|rssi|wifi|firmware|diagnost/i.test(lowerMsg) && d.entity_category === 'diagnostic') score += 8;

        return { device: d, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const initialTop = scored.filter(s => s.score > 0).slice(0, 22).map(s => s.device);

    // Also pull sibling entities (including diagnostic toner/battery/status sensors) of the top 2 matched physical devices!
    const selected: any[] = [...initialTop];
    const selectedIds = new Set<string>(selected.map(d => d.entity_id));
    const topDeviceIds = new Set<string>();
    for (const d of initialTop.slice(0, 4)) {
        if ((d as any).device_id) {
            topDeviceIds.add((d as any).device_id);
            if (topDeviceIds.size >= 2) break;
        }
    }
    if (topDeviceIds.size > 0) {
        for (const d of devices as any[]) {
            if (selected.length >= 30) break;
            if (d.device_id && topDeviceIds.has(d.device_id) && !selectedIds.has(d.entity_id)) {
                selectedIds.add(d.entity_id);
                selected.push(d);
            }
        }
    }

    if (selected.length === 0) {
        selected.push(
            ...devices
                .filter(d => d.state === 'on' || /^(climate|alarm_control_panel|lock)\./.test(d.entity_id))
                .slice(0, 12)
        );
    }

    const relevantDevicesText = selected.map((d: any) => {
        const name = d.attributes?.friendly_name || d.entity_id;
        const devLabel = d.device_name && !name.toLowerCase().includes(d.device_name.toLowerCase())
            ? `${d.device_name} — ${name}`
            : name;
        const areaTag = d.area_name ? ` [${d.area_name}]` : '';
        const catTag = d.entity_category === 'diagnostic' ? ' [diag]' : '';
        const uom = d.attributes?.unit_of_measurement ? ` ${d.attributes.unit_of_measurement}` : '';
        const opts = Array.isArray(d.attributes?.options) && d.attributes.options.length > 0
            ? ` (opties: ${d.attributes.options.slice(0, 20).join(', ')})`
            : '';
        return `- ${d.entity_id} (${devLabel}${areaTag}${catTag}): ${d.state}${uom}${opts}`;
    }).join('\n');

    return {
        topologySummary,
        relevantEntitiesSection: relevantDevicesText || 'Gebruik search_home_entities om apparaten op te zoeken.',
        matchedCount: selected.length
    };
}

// -------------------------------------------------------------
// 9. Clean LLM-First System Prompt
// -------------------------------------------------------------
function buildSystemPrompt(options: ClientOrchestratorOptions): string {
    const { language, location, devices, userMessage, connectionId } = options;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('nl-BE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const ctx = selectInitialContextEntities(userMessage, devices, connectionId);
    const storedMems = getStoredMemories().map(m => `- ${m.content}`).join('\n') || '- Geen voorkeuren opgeslagen.';
    const locationContext = location
        ? `Coördinaten: ${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}`
        : 'Locatie: Thuisbasis (geen live GPS)';

    const activeRecipe = getActiveRecipeSession();
    const activeRecipeSection = activeRecipe
        ? `\n### ACTIEVE KOOKSESSIE (scherm blijft aan):\n- Gerecht: "${activeRecipe.title}" (${activeRecipe.servings} pers.)\n- Huidige stap: ${activeRecipe.currentStepIndex + 1} van ${activeRecipe.steps.length}: ${activeRecipe.steps[activeRecipe.currentStepIndex]?.instruction || ''}\n- Gebruik \`cooking_assistant\` (next_step, previous_step, repeat_step, goto_step, scale_servings, list_ingredients, finish_recipe) bij vervolgvragen zoals "volgende stap", "terug", "herhaal", "voor 4 personen" of "klaar".\n`
        : '';

    return `Je bent Butler, een intelligente, snelle en betrouwbare persoonlijke AI-assistent voor zowel Home Assistant als het hele dagelijks leven (telefoon, agenda, documenten, boodschappen, navigatie, koken, media en live internet).

### CONTEXT:
- Datum & Tijd: ${dateStr}, ${timeStr}
- Locatie: ${locationContext}
- Voorkeurstaal: ${language} (Antwoord in de taal van de gebruiker; standaard Nederlands)
${activeRecipeSection}
${ctx.topologySummary}
### RELEVANTE ENTITEITEN (${ctx.matchedCount} uit ${devices.length} — gebruik \`search_home_entities\` voor overige apparaten & diagnostiek):
${ctx.relevantEntitiesSection}

### PERSOONLIJK GEHEUGEN:
${storedMems}

### RICHTLIJNEN:
1. Gebruik altijd je tools om actuele data op te halen of acties uit te voeren — verzin nooit waarden en beweer nooit dat een functie of sensor ontbreekt zonder eerst \`search_home_entities\` (en eventueel zonder filters voor een volledige apparaatinventaris) te raadplegen. Je hebt toegang tot ALLE Home Assistant-data inclusief diagnostische sensoren (zoals printer-toner/inkt, batterijpercentages, signaalsterkte, firmware, tellers en attributen).
2. **Live Google Search (\`google_search\`)**: Voor elke vraag over actuele publieke informatie buiten Home Assistant (zoals Belgische/Nederlandse brandstof- en dieselprijzen vandaag/morgen/gisteren, nieuws, verkeer, openingsuren, sportuitslagen, koersen, authentieke recepten of feiten) MOET je direct \`google_search\` aanroepen.
3. **Telefoon & Hardware (\`control_phone\`, \`set_timer_or_alarm\`, \`communicate_with_contact\`)**: Je kunt op de Android-telefoon direct de zaklamp aan/uit/toggelen, het volume of de geluidsmodus (normaal/trillen/stil) wijzigen, de batterijstatus uitlezen, apps openen (Spotify, YouTube, Maps, WhatsApp, Docs, Sheets, Instellingen, Wi-Fi, Bluetooth), wekkers/timers zetten en contacten bellen of berichten voorbereiden via WhatsApp/SMS.
4. **Agenda, Taken, Documenten, Mail & Media**:
   - \`manage_calendar\` leest zowel Home Assistant-kalenders als Google Calendar tegelijk, en kan afspraken aanmaken/aanpassen/verwijderen in Google Calendar.
   - \`manage_todo_list\` ondersteunt Home Assistant boodschappenlijsten én Google Tasks, inclusief \`action="add_many"\` om alle ingrediënten van een recept in één keer toe te voegen.
   - \`manage_google_docs\` & \`manage_google_sheets\` kunnen documenten en spreadsheets opzoeken, lezen, nieuw aanmaken en bewerken.
   - \`manage_email\` leest en zoekt Gmail; **veiligheid**: verstuur met \`action="send"\` alleen een e-mail als de gebruiker expliciet ontvanger, onderwerp/inhoud en verzendopdracht gaf (vraag anders kort bevestiging).
   - \`control_media_services\` bedient Spotify en zoekt/opent YouTube.
   - \`get_navigation_eta\` berekent echte wegennet-routes via OSRM en kan met \`start_navigation=true\` direct Google Maps navigatie starten.
5. **Stap-voor-stap Koken (\`cooking_assistant\`)**: Wanneer de gebruiker een gerecht wil maken of stap-voor-stap begeleiding vraagt, roep \`cooking_assistant\` aan met \`action="start_recipe"\` (met volledige ingrediëntenlijst en heldere, korte spreekbare stappen inclusief \`timer_minutes\` waar van toepassing). Geef bij elke stap alleen de actuele stap rustig door (niet alle 8 stappen in één keer oplezen!) zodat de gebruiker hands-free met "volgende stap" of de knoppen op het scherm kan koken.
6. Roep gerust meerdere tools tegelijk aan in één beurt wanneer dat sneller is (ze worden parallel uitgevoerd).
7. Controleer bij prijzen, eenheden en sensoren altijd de daadwerkelijke eenheid (€/kWh vs €/m³ vs €/liter) en naam voordat je antwoordt.
8. Voor een camera-snapshot analyseer je het meegestuurde beeld nauwkeurig en beschrijf je wat je ziet.
9. **Adaptief redeneren**: Behandel snelle dagelijkse vragen direct zelf. Alleen bij complexe vragen (meerstaps-optimalisatie, complexe automatiseringen, programmeren, wiskunde/logica, diepe analyse of hoog-risico advies) roep je \`consult_deep_reasoner\` aan met alle relevante context (nadat je eventuele live data eerst hebt opgehaald).

### ANTWOORDSTIJL (DUBBEL KANAAL: MENSELIJKE SPRAAK + VISUEEL OVERZICHT):
Geef altijd een natuurlijk, vlot antwoord zonder stijf taalgebruik. Gebruik daarbij twee gescheiden kanalen in je uiteindelijke antwoord:

1. **Spraak-kanaal (\`<spoken>...</spoken>\`) — VERPLICHT bij elk eindantwoord**:
   - Schrijf hierin precies wat Butler luidop tegen de gebruiker zegt, alsof een vriendelijke, slimme menselijke assistent naast je in de woonkamer praat.
   - Gebruik NOOIT opsommingen, dubbele punten met label-waarde paren ("Temperatuur: 15 graden; Dauwpunt: 5 graden"), puntkomma's, lijstjes, haakjes of stijve telegramstijl in \`<spoken>\`.
   - Maak er vlotte, warme mensentaal van in 1 tot 3 korte zinnen (bijv. *"Het is buiten 15 graden met een dauwpunt van 5 graden en een zacht briesje, lekker aangenaam dus."* of *"De wasmachine draait nog op katoen en is over 32 minuten klaar. De droogkast staat momenteel uit."*).

2. **Visueel Overzicht (\`<card>...</card>\`) — GEBRUIK WANNEER CIJFERS, STATUSSEN, TIJDEN, VERGELIJKINGEN OF MEERDERE GEGEVENS HELDERDER ZIJN IN 1 OOGOPSLAG**:
   - Zodra je meerdere meetwaarden, apparaatstatussen (zoals wasmachine & droogkast), uurtarieven, brandstofprijzen, vergelijkingen, berekeningen, schema's of overzichten toont, voeg dan een compact, geldig JSON-blok toe in \`<card>...</card>\` zodat de gebruiker zonder lezen in één oogopslag het antwoord ziet.
   - Sla \`<card>\` over bij simpele éénzins-bevestigingen (zoals "Het licht staat aan").
   - Gebruik alleen de velden die echt relevant zijn voor de vraag (niet overvol maken!):
     \`\`\`json
     <card>
     {
       "title": "Korte heldere titel",
       "subtitle": "Optioneel tijdstip of context",
       "icon": "🫧",
       "highlights": [
         { "label": "Wasmachine", "value": "32 min", "sub": "Katoen 40°C", "tone": "active" },
         { "label": "Droogkast", "value": "Uit", "sub": "Stand-by", "tone": "neutral" }
       ],
       "rows": [
         { "label": "Eindtijd", "value": "14:45", "badge": "Bezig", "tone": "good" }
       ],
       "columns": ["Tijd", "Prijs", "Status"],
       "table": [
         ["14:00", "€0,24", "Goedkoop"],
         ["15:00", "€0,22", "Laagst"]
       ],
       "footer": "Optionele korte tip"
     }
     </card>
     \`\`\`
   - Geldige \`tone\`-waarden: \`"good"\` (groen), \`"active"\` (blauw/paars), \`"warn"\` (oranje), \`"alert"\` (rood), \`"neutral"\` (neutraal).
   - Buiten \`<spoken>\` en \`<card>\` mag je kort en helder een 1-zins toelichting in de chat zetten (of leeg laten als \`<spoken>\` + \`<card>\` al alles dekken; herhaal nooit dezelfde tabel of cijfers dubbel als platte tekst).`;
}

interface ParsedDualChannel {
    displayText: string;
    spokenText: string;
    visualCards: Record<string, any>[];
}

function parseDualChannelResponse(rawText: string): ParsedDualChannel {
    if (!rawText || !rawText.trim()) {
        return { displayText: '', spokenText: '', visualCards: [] };
    }

    let working = rawText;

    // 1. Extract <spoken>...</spoken>
    let spokenText = '';
    const spokenMatches = Array.from(working.matchAll(/<spoken>([\s\S]*?)<\/spoken>/gi));
    if (spokenMatches.length > 0) {
        spokenText = spokenMatches.map(m => (m[1] || '').trim()).filter(Boolean).join(' ');
        working = working.replace(/<spoken>[\s\S]*?<\/spoken>/gi, '');
    }

    // 2. Extract all <card>...</card> JSON blocks defensively
    const visualCards: Record<string, any>[] = [];
    working = working.replace(/<card>([\s\S]*?)<\/card>/gi, (_full, inner) => {
        const cleanedJson = String(inner || '')
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        if (!cleanedJson) return '';
        try {
            const parsed = JSON.parse(cleanedJson);
            if (
                parsed &&
                typeof parsed === 'object' &&
                (parsed.title ||
                    (Array.isArray(parsed.highlights) && parsed.highlights.length > 0) ||
                    (Array.isArray(parsed.rows) && parsed.rows.length > 0) ||
                    (Array.isArray(parsed.table) && parsed.table.length > 0))
            ) {
                visualCards.push(parsed);
            }
        } catch (err) {
            logger.warn('[ClientOrchestrator] Ignored malformed <card> JSON:', err);
        }
        return '';
    });

    // 3. Defensively strip any stray/unclosed protocol tags
    const displayCandidate = working
        .replace(/<\/?(?:spoken|card)\b[^>]*>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    // 4. Reconcile display & spoken cleanly so neither is ever blank
    const finalDisplay = displayCandidate || spokenText || rawText.trim();
    const finalSpoken = spokenText || finalDisplay;

    return {
        displayText: finalDisplay,
        spokenText: finalSpoken,
        visualCards
    };
}

// -------------------------------------------------------------
// 10. Unified SOTA ReAct Loop with Automatic Model Failover, Parallel Tools & Self-Escalation
// -------------------------------------------------------------

/**
 * SOTA Live Google Search Tool (3-Tier, Zero Extra API Key Required):
 * 1. Native Google Gemini Search Grounding (`tools: [{ google_search: {} }]`) using the user's Gemini key
 * 2. OpenRouter native Web Search plugin (`plugins: [{ id: 'web' }]`) for OpenRouter users
 * 3. DuckDuckGo Instant Answer fallback
 */
async function executeGoogleSearchTool(
    args: { query?: string; region?: string },
    config: AIResolvedConfig,
    language: string,
    log: (msg: string) => void
): Promise<any> {
    const query = (args.query || '').trim();
    if (!query) return { error: 'Geen zoekopdracht opgegeven.' };

    const now = new Date();
    const dateStr = now.toLocaleDateString('nl-BE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const defaultRegion = language.toLowerCase().includes('be') ? 'België' : language.toLowerCase().startsWith('nl') ? 'België / Nederland' : 'International';
    const regionHint = (args.region || '').trim() || defaultRegion;

    // Resolve Gemini API key (active provider or stored Gemini key)
    const geminiKey = (
        (config.provider === 'gemini' ? config.apiKey : '') ||
        (typeof localStorage !== 'undefined' ? localStorage.getItem('butler.gemini_api_key') : '') ||
        ((import.meta as any).env?.VITE_GEMINI_API_KEY || '')
    ).trim();

    // TIER 1: Native Google Gemini Google Search Grounding (real live Google Search + citations!)
    if (geminiKey) {
        const groundingModels = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
        const searchPrompt = `Zoek live op Google naar de meest actuele en geverifieerde feiten voor deze vraag.
Datum vandaag: ${dateStr}. Regio/context: ${regionHint}.
Geef een concreet, feitelijk en beknopt overzicht met exacte cijfers, datums en eventuele vergelijkingen (bv. gisteren / vandaag / morgen). Verzin geen cijfers als ze niet in de zoekresultaten staan.

Zoekvraag: ${query}`;

        for (const model of groundingModels) {
            try {
                log(`🌐 Google Search Grounding via ${model}: "${query}"`);
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
                const res = await fetchWithTimeout(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': geminiKey
                    },
                    body: JSON.stringify({
                        contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
                        tools: [{ google_search: {} }]
                    })
                }, 22000);

                if (res.ok) {
                    const data = await res.json();
                    const candidate = data?.candidates?.[0];
                    const textParts = (candidate?.content?.parts || [])
                        .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
                        .filter(Boolean);
                    const answer = textParts.join('\n').trim();

                    const meta = candidate?.groundingMetadata || {};
                    const webQueries: string[] = Array.isArray(meta.webSearchQueries) ? meta.webSearchQueries : [];
                    const rawChunks: any[] = Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [];
                    const seenUrls = new Set<string>();
                    const sources: Array<{ title: string; url: string }> = [];
                    for (const ch of rawChunks) {
                        const uri = ch?.web?.uri;
                        const title = ch?.web?.title || uri;
                        if (uri && !seenUrls.has(uri)) {
                            seenUrls.add(uri);
                            sources.push({ title, url: uri });
                            if (sources.length >= 5) break;
                        }
                    }

                    if (answer) {
                        log(`✅ Google Search voltooid via ${model} (${sources.length} bronnen)`);
                        return {
                            engine: `Google Search (Gemini Grounding • ${model})`,
                            date: dateStr,
                            query,
                            search_queries_used: webQueries,
                            answer,
                            sources
                        };
                    }
                } else {
                    const errText = await res.text().catch(() => '');
                    logger.warn(`[GoogleSearch] ${model} failed (${res.status}): ${errText.slice(0, 180)}`);
                    if (res.status === 401 || res.status === 403) break;
                }
            } catch (err: any) {
                logger.warn(`[GoogleSearch] ${model} error:`, err?.message || err);
            }
        }
    }

    // TIER 2: OpenRouter Built-in Live Web Search Plugin
    if (config.provider === 'openrouter' && config.apiKey) {
        try {
            log(`🌐 OpenRouter Live Web Search: "${query}"`);
            const res = await fetchWithTimeout(OPENROUTER_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                    'HTTP-Referer': 'https://butler.aiha.app',
                    'X-Title': 'Butler AI App (Web Search)'
                },
                body: JSON.stringify({
                    model: config.model,
                    plugins: [{ id: 'web', max_results: 5 }],
                    messages: [
                        {
                            role: 'user',
                            content: `Datum vandaag: ${dateStr}. Regio: ${regionHint}. Zoek live op internet en geef concrete, actuele cijfers en bronnen voor: ${query}`
                        }
                    ],
                    max_tokens: 1500
                })
            }, 22000);

            if (res.ok) {
                const data = await res.json();
                const answer = data?.choices?.[0]?.message?.content?.trim();
                const annotations: any[] = data?.choices?.[0]?.message?.annotations || [];
                const sources = annotations
                    .filter(a => a?.type === 'url_citation' && a?.url_citation?.url)
                    .slice(0, 5)
                    .map(a => ({ title: a.url_citation.title || a.url_citation.url, url: a.url_citation.url }));
                if (answer) {
                    return {
                        engine: 'OpenRouter Web Search',
                        date: dateStr,
                        query,
                        answer,
                        sources
                    };
                }
            }
        } catch (err: any) {
            logger.warn('[GoogleSearch] OpenRouter web plugin error:', err?.message || err);
        }
    }

    // TIER 3: DuckDuckGo Instant Answer zero-key fallback
    try {
        const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const ddgRes = await fetchWithTimeout(ddgUrl, {}, 8000);
        if (ddgRes.ok) {
            const ddg = await ddgRes.json();
            const snippet = ddg?.AbstractText || ddg?.Answer || (ddg?.RelatedTopics?.[0]?.Text || '');
            if (snippet) {
                return {
                    engine: 'DuckDuckGo Instant Answer',
                    date: dateStr,
                    query,
                    answer: snippet,
                    sources: ddg?.AbstractURL ? [{ title: ddg.AbstractSource || 'Bron', url: ddg.AbstractURL }] : []
                };
            }
        }
    } catch { }

    return {
        error: `Kon geen live zoekresultaten ophalen voor "${query}". Controleer je internetverbinding of Gemini API-sleutel.`
    };
}

async function executeDeepReasonerTool(
    args: { task?: string; context?: string; depth?: 'medium' | 'high' },
    config: AIResolvedConfig,
    language: string,
    log: (msg: string) => void
): Promise<{ answer: string; model_used: string; depth: 'medium' | 'high'; elapsed_ms: number } | { error: string }> {
    const depth: 'medium' | 'high' = args.depth === 'high' ? 'high' : 'medium';
    const task = (args.task || '').trim();
    if (!task) return { error: 'Geen taak opgegeven voor deep reasoner.' };

    const candidates = getEscalationModels(depth, config.provider);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
    };
    if (config.provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://butler.aiha.app';
        headers['X-Title'] = 'Butler AI App (Deep Reasoner)';
    }

    const systemPrompt = `Je bent Butler's diepe redeneer- en analyse-engine.
Lever een foutloos, grondig doordacht en direct bruikbaar resultaat in taal: ${language}.
- Gebruik uitsluitend echte entity_ids en feiten uit de aangeleverde context; verzin niets.
- Bij berekeningen of optimalisaties: controleer elke stap zorgvuldig.
- Bij Home Assistant-automatiseringen: lever zuivere, uitvoerbare structuur (triggers, conditions, actions).`;

    const userPrompt = args.context?.trim()
        ? `TAAK:\n${task}\n\nACTUELE CONTEXT & DATA:\n${args.context.trim()}`
        : `TAAK:\n${task}`;

    const started = Date.now();
    let lastError = 'Deep Reasoner niet beschikbaar';

    for (let i = 0; i < candidates.length; i++) {
        const candidateModel = candidates[i];
        const body: Record<string, any> = {
            model: candidateModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: 10000
        };

        if (supportsTemperatureParam(candidateModel)) {
            body.temperature = 0.2;
        }
        if (supportsReasoningEffort(candidateModel)) {
            body.reasoning_effort = depth;
        }
        if (config.provider === 'openrouter' && i === 0 && candidates.length > 1) {
            body.models = candidates;
        }

        try {
            log(`🧠 Escalating to ${candidateModel} (depth: ${depth})...`);
            const res = await fetchWithTimeout(config.endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            }, 60000);

            if (res.ok) {
                const data = await res.json();
                const answer = data?.choices?.[0]?.message?.content?.trim();
                if (answer) {
                    const elapsed = Date.now() - started;
                    log(`🧠 Escalation complete via ${candidateModel} in ${elapsed}ms`);
                    return { answer, model_used: candidateModel, depth, elapsed_ms: elapsed };
                }
                lastError = `Leeg antwoord van ${candidateModel}`;
            } else {
                const errText = await res.text().catch(() => '');
                lastError = `${candidateModel} (${res.status}): ${errText.slice(0, 200)}`;
                if (res.status === 401 || res.status === 403) break;
            }
        } catch (err: any) {
            lastError = err?.name === 'AbortError' ? `Timeout (60s) op ${candidateModel}` : (err?.message || String(err));
        }
    }

    return { error: `Deep Reasoner escalatie mislukt: ${lastError}` };
}

async function callLLMWithFailover(
    config: AIResolvedConfig,
    messages: any[],
    includeTools: boolean,
    log: (msg: string) => void
): Promise<{ data: any; usedModel: string }> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
    };
    if (config.provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://butler.aiha.app';
        headers['X-Title'] = 'Butler AI App';
    }

    // In 'auto' adaptive mode, fast turns run at 'low' effort and only escalate via `consult_deep_reasoner`.
    const effectiveEffort: 'low' | 'medium' | 'high' =
        config.reasoningEffort === 'auto' ? 'low' : config.reasoningEffort;

    // Only expose `consult_deep_reasoner` when adaptive ('auto') or when running at 'low'/'medium'
    const activeTools = config.reasoningEffort === 'high'
        ? ORCHESTRATOR_TOOLS.filter(t => t.function.name !== 'consult_deep_reasoner')
        : ORCHESTRATOR_TOOLS;

    const candidates = config.fallbackModels;
    let lastError = 'Onbekende LLM API fout';

    for (let i = 0; i < candidates.length; i++) {
        const candidateModel = candidates[i];
        const body: Record<string, any> = {
            model: candidateModel,
            messages,
            max_tokens: 8192
        };

        if (includeTools) {
            body.tools = activeTools;
            body.tool_choice = 'auto';
        }

        // Gemini 3.6+/3.8/4.x deprecate temperature and use reasoning_effort instead!
        if (supportsTemperatureParam(candidateModel)) {
            body.temperature = 0.3;
        }
        if (supportsReasoningEffort(candidateModel)) {
            body.reasoning_effort = effectiveEffort;
        }

        // On OpenRouter, also supply native fallback models array on the first attempt
        if (config.provider === 'openrouter' && i === 0 && candidates.length > 1) {
            body.models = candidates;
        }

        try {
            const res = await fetchWithTimeout(config.endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            }, 35000);

            if (res.ok) {
                const data = await res.json();
                if (data?.choices?.[0]?.message) {
                    return { data, usedModel: candidateModel };
                }
                lastError = `Leeg of ongeldig API-antwoord van ${candidateModel}: ${JSON.stringify(data).slice(0, 200)}`;
            } else {
                const errText = await res.text().catch(() => '');
                lastError = `${config.provider.toUpperCase()} (${res.status}) op ${candidateModel}: ${errText.slice(0, 250)}`;
                log(`⚠️ Model ${candidateModel} fout (${res.status}), probeer failover indien mogelijk...`);

                if (res.status === 401 || res.status === 403) {
                    throw new Error(lastError);
                }
            }
        } catch (err: any) {
            const msg = err?.name === 'AbortError' ? `Timeout (35s) bij ${candidateModel}` : (err?.message || String(err));
            lastError = msg;
            if (msg.includes('(401)') || msg.includes('(403)')) {
                throw err;
            }
            log(`⚠️ Failover trigger na fout op ${candidateModel}: ${msg}`);
        }
    }

    throw new Error(lastError);
}

export async function runClientReActOrchestrator(
    options: ClientOrchestratorOptions
): Promise<LLMResponse> {
    const config = resolveAIConfig(options.apiKey, options.model, options.provider);
    if (!config.apiKey) {
        throw new Error('NO_API_KEY');
    }

    const systemPrompt = buildSystemPrompt(options);

    // Ensure alternating clean message history (no consecutive duplicate roles or empty messages)
    const messages: any[] = [{ role: 'system', content: systemPrompt }];
    for (const h of options.recentHistory) {
        if (!h.content || !h.content.trim()) continue;
        const role = h.role === 'assistant' ? 'assistant' : 'user';
        if (messages.length > 1 && messages[messages.length - 1].role === role) {
            messages[messages.length - 1].content += `\n${h.content}`;
        } else {
            messages.push({ role, content: h.content });
        }
    }
    if (messages.length > 1 && messages[messages.length - 1].role === 'user') {
        messages[messages.length - 1].content += `\n${options.userMessage}`;
    } else {
        messages.push({ role: 'user', content: options.userMessage });
    }

    const actionsTaken: Action[] = [];
    const executionLogs: string[] = [];
    const log = (msg: string) => {
        executionLogs.push(msg);
        logger.info(`[ClientOrchestrator] ${msg}`);
    };

    log(`🚀 ReAct v2 started [${config.provider.toUpperCase()}] Primary: ${config.model} (effort: ${config.reasoningEffort})`);

    const MAX_TURNS = 5;
    let turn = 0;
    let finalResponseText = '';

    while (turn < MAX_TURNS) {
        turn++;
        log(`🔄 Turn ${turn}/${MAX_TURNS}...`);

        const { data, usedModel } = await callLLMWithFailover(config, messages, true, log);
        if (turn === 1 && usedModel !== config.model) {
            log(`🔁 Failover actief: gebruikt model ${usedModel}`);
        }

        const assistantMsg = data.choices[0].message;

        // Preserve Gemini thought_signature / reasoning_details intact while ensuring tool_call IDs exist
        if (Array.isArray(assistantMsg.tool_calls) && assistantMsg.tool_calls.length > 0) {
            assistantMsg.tool_calls.forEach((tc: any, idx: number) => {
                if (!tc.id || !tc.id.trim()) {
                    tc.id = `call_${Date.now()}_${idx}`;
                }
            });
            messages.push(assistantMsg);

            log(`🛠️ Executing ${assistantMsg.tool_calls.length} tool call(s) in parallel`);
            const pendingVisionImages: Array<{ entityId: string; dataUrl: string }> = [];

            // Execute all tool calls in this turn IN PARALLEL for minimal latency!
            const toolResults = await Promise.all(
                assistantMsg.tool_calls.map(async (toolCall: any) => {
                    const fnName = toolCall.function?.name || 'unknown';
                    const callId = toolCall.id;
                    let fnArgs: any = {};
                    try {
                        fnArgs = JSON.parse(toolCall.function?.arguments || '{}');
                    } catch (parseErr: any) {
                        return {
                            callId,
                            fnName,
                            result: { error: `Ongeldige JSON in tool-argumenten: ${parseErr?.message}` }
                        };
                    }

                    log(`⚙️ Tool: ${fnName}(${JSON.stringify(fnArgs).slice(0, 150)})`);
                    let toolResult: any;

                    try {
                        if (fnName === 'get_weather') {
                            toolResult = await executeWeatherTool(fnArgs, options.location);
                            actionsTaken.push({
                                type: 'weather',
                                entity_id: 'weather.open_meteo',
                                service: 'weather.get_forecast',
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'google_search') {
                            toolResult = await executeGoogleSearchTool(
                                fnArgs,
                                config,
                                options.language || 'nl-BE',
                                log
                            );
                            actionsTaken.push({
                                type: 'search',
                                entity_id: 'google_search',
                                service: 'google.search',
                                data: {
                                    query: fnArgs.query,
                                    engine: toolResult?.engine,
                                    sources: toolResult?.sources || []
                                },
                                result: toolResult?.error ? 'error' : 'success',
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
                                entity_id: toolResult?.entity_id || 'sensor.energy_prices',
                                service: 'energy.get_prices',
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'get_entity_state') {
                            toolResult = await executeGetEntityStateTool(fnArgs, {
                                devices: options.devices,
                                haUrl: options.haUrl,
                                haToken: options.haToken
                            });
                        } else if (fnName === 'search_home_entities') {
                            toolResult = await executeSearchEntitiesTool(fnArgs, {
                                devices: options.devices,
                                haUrl: options.haUrl,
                                haToken: options.haToken,
                                connectionId: options.connectionId
                            });
                        } else if (fnName === 'control_home_device') {
                            const devRes = await executeDeviceControl(fnArgs, {
                                haWebSocket: options.haWebSocket,
                                haUrl: options.haUrl,
                                haToken: options.haToken
                            });
                            toolResult = { success: devRes.success, message: devRes.message };
                            actionsTaken.push(devRes.action);
                        } else if (fnName === 'manage_core_memory') {
                            toolResult = await executeCoreMemoryTool(fnArgs, options.connectionId);
                        } else if (fnName === 'get_navigation_eta') {
                            toolResult = await executeNavigationTool(fnArgs, options.location);
                            actionsTaken.push({
                                type: 'navigation',
                                entity_id: 'device.navigation',
                                service: 'navigation.eta',
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'get_ha_history_and_statistics') {
                            if (!options.haUrl || !options.haToken) {
                                toolResult = { error: 'Geen actieve Home Assistant verbinding.' };
                            } else {
                                toolResult = await fetchHAHistory(options.haUrl, options.haToken, fnArgs.entity_id, fnArgs.hours_ago || 24);
                            }
                            actionsTaken.push({
                                type: 'history',
                                entity_id: fnArgs.entity_id,
                                service: 'history.period',
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'get_ha_logbook') {
                            if (!options.haUrl || !options.haToken) {
                                toolResult = { error: 'Geen actieve Home Assistant verbinding.' };
                            } else {
                                toolResult = await fetchHALogbook(options.haUrl, options.haToken, fnArgs.entity_id, fnArgs.hours_ago || 24);
                            }
                            actionsTaken.push({
                                type: 'logbook',
                                entity_id: fnArgs.entity_id || 'logbook',
                                service: 'logbook.get_events',
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'capture_camera_snapshot') {
                            if (!options.haUrl || !options.haToken) {
                                toolResult = { error: 'Geen actieve Home Assistant verbinding.' };
                            } else {
                                const snap = await fetchHACameraSnapshot(options.haUrl, options.haToken, fnArgs.camera_entity_id);
                                // Queue real multimodal image block for Gemini vision (NEVER dump base64 into tool JSON!)
                                pendingVisionImages.push({ entityId: snap.entity_id, dataUrl: snap.dataUrl });
                                toolResult = {
                                    success: true,
                                    entity_id: snap.entity_id,
                                    message: `Live snapshot van ${snap.entity_id} opgehaald. Het beeld wordt direct meegestuurd voor visuele analyse.`
                                };
                                actionsTaken.push({
                                    type: 'camera',
                                    entity_id: snap.entity_id,
                                    service: 'camera.snapshot',
                                    data: { entity_id: snap.entity_id, snapshot_data_url: snap.dataUrl, has_image: true },
                                    result: 'success',
                                    executedLocally: true
                                });
                            }
                        } else if (fnName === 'manage_todo_list') {
                            const source: 'auto' | 'ha' | 'google' = fnArgs.source || 'auto';
                            const hasHATodo = Boolean(
                                options.haUrl &&
                                options.haToken &&
                                (fnArgs.list_entity_id || options.devices.some(d => d.entity_id.startsWith('todo.')))
                            );
                            const useGoogle = source === 'google' || fnArgs.action === 'list_lists' || (source === 'auto' && !hasHATodo);

                            if (useGoogle) {
                                toolResult = await manageGoogleTasks({
                                    action: fnArgs.action,
                                    list_id: fnArgs.list_id,
                                    item: fnArgs.item,
                                    items: fnArgs.items,
                                    due_date: fnArgs.due_date
                                });
                                // Normalize pending_items for Todo UI widget compatibility
                                if (Array.isArray(toolResult?.tasks)) {
                                    toolResult.pending_items = toolResult.tasks.map((t: any) => ({ summary: t.title, id: t.id }));
                                    toolResult.list_entity_id = 'Google Tasks';
                                } else if (Array.isArray(toolResult?.items)) {
                                    toolResult.pending_items = toolResult.items.map((title: string) => ({ summary: title }));
                                    toolResult.list_entity_id = 'Google Tasks';
                                }
                            } else if (!options.haUrl || !options.haToken) {
                                toolResult = { error: 'Geen actieve Home Assistant verbinding en Google Tasks niet geselecteerd.' };
                            } else if (fnArgs.action === 'list') {
                                const haRes: any = await fetchHATodoItems(options.haUrl, options.haToken, fnArgs.list_entity_id);
                                if (source === 'auto') {
                                    const gRes: any = await manageGoogleTasks({ action: 'list', list_id: fnArgs.list_id }).catch(() => null);
                                    if (gRes && Array.isArray(gRes.tasks) && gRes.tasks.length > 0) {
                                        toolResult = {
                                            ...haRes,
                                            google_tasks: gRes.tasks
                                        };
                                    } else {
                                        toolResult = haRes;
                                    }
                                } else {
                                    toolResult = haRes;
                                }
                            } else if (fnArgs.action === 'add_many' && Array.isArray(fnArgs.items) && fnArgs.items.length > 0) {
                                let targetList = fnArgs.list_entity_id;
                                if (!targetList) {
                                    const discovered = await fetchHATodoItems(options.haUrl, options.haToken);
                                    targetList = (discovered as any)?.list_entity_id || 'todo.shopping_list';
                                }
                                const addedItems: string[] = [];
                                for (const rawItem of fnArgs.items.slice(0, 30)) {
                                    const clean = String(rawItem || '').trim();
                                    if (!clean) continue;
                                    await manageHATodoItem(options.haUrl, options.haToken, 'add', {
                                        listEntityId: targetList,
                                        item: clean
                                    });
                                    addedItems.push(clean);
                                }
                                toolResult = {
                                    success: true,
                                    action: 'add_many',
                                    list_entity_id: targetList,
                                    added_count: addedItems.length,
                                    pending_items: addedItems.map(summary => ({ summary }))
                                };
                            } else {
                                let targetList = fnArgs.list_entity_id;
                                if (!targetList) {
                                    const discovered = await fetchHATodoItems(options.haUrl, options.haToken);
                                    targetList = (discovered as any)?.list_entity_id || 'todo.shopping_list';
                                }
                                toolResult = await manageHATodoItem(options.haUrl, options.haToken, fnArgs.action, {
                                    listEntityId: targetList,
                                    item: fnArgs.item
                                });
                            }
                            actionsTaken.push({
                                type: 'todo',
                                entity_id: toolResult?.list_entity_id || fnArgs.list_entity_id || (useGoogle ? 'Google Tasks' : 'todo.shopping_list'),
                                service: `todo.${fnArgs.action}`,
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'manage_calendar' || fnName === 'get_calendar_events') {
                            const calAction = fnName === 'get_calendar_events' ? 'list' : (fnArgs.action || 'list');
                            if (calAction === 'list') {
                                const days = fnArgs.days_ahead || 7;
                                const [haRes, gRes] = await Promise.all([
                                    options.haUrl && options.haToken
                                        ? fetchHACalendarEvents(options.haUrl, options.haToken, fnArgs.calendar_entity_id, days).catch((e: any) => ({ error: e?.message, events: [] }))
                                        : Promise.resolve({ events: [] } as any),
                                    fnArgs.calendar_entity_id
                                        ? Promise.resolve({ events: [] } as any)
                                        : listGoogleCalendarEvents(days, 25).catch((e: any) => ({ error: e?.message, events: [] }))
                                ]);
                                const haEvents = Array.isArray(haRes?.events) ? haRes.events : [];
                                const gEvents = Array.isArray(gRes?.events) ? gRes.events : [];
                                const merged = [...gEvents, ...haEvents].sort((a: any, b: any) => {
                                    const ta = new Date(a?.start || 0).getTime() || 0;
                                    const tb = new Date(b?.start || 0).getTime() || 0;
                                    return ta - tb;
                                });
                                const sources: string[] = [];
                                if (gEvents.length > 0 || (!gRes?.error && !fnArgs.calendar_entity_id)) sources.push('Google Calendar');
                                if (haEvents.length > 0 || (options.haUrl && options.haToken && !haRes?.error)) sources.push('Home Assistant');

                                if (merged.length === 0 && gRes?.needs_oauth && (!options.haUrl || !options.haToken)) {
                                    toolResult = { error: gRes.error, needs_oauth: true, events: [] };
                                } else {
                                    toolResult = {
                                        sources,
                                        days_ahead: days,
                                        total_events: merged.length,
                                        events: merged.slice(0, 30),
                                        google_calendar_note: gRes?.needs_oauth ? gRes.error : undefined
                                    };
                                }
                            } else if (calAction === 'create') {
                                toolResult = await createGoogleCalendarEvent({
                                    summary: fnArgs.summary || 'Afspraak',
                                    start_time: fnArgs.start_time,
                                    duration_minutes: fnArgs.duration_minutes,
                                    location: fnArgs.location,
                                    description: fnArgs.description
                                });
                            } else if (calAction === 'update') {
                                toolResult = await updateGoogleCalendarEvent({
                                    event_id: fnArgs.event_id,
                                    summary: fnArgs.summary,
                                    start_time: fnArgs.start_time,
                                    duration_minutes: fnArgs.duration_minutes,
                                    location: fnArgs.location,
                                    description: fnArgs.description
                                });
                            } else if (calAction === 'delete') {
                                toolResult = await deleteGoogleCalendarEvent(fnArgs.event_id);
                            } else {
                                toolResult = { error: `Onbekende agenda-actie: ${calAction}` };
                            }
                            actionsTaken.push({
                                type: 'calendar',
                                entity_id: fnArgs.calendar_entity_id || 'calendar.unified',
                                service: `calendar.${calAction}`,
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'control_phone') {
                            const act = fnArgs.action;
                            if (act === 'flashlight') {
                                toolResult = await setPhoneFlashlight(fnArgs.flashlight_mode || 'toggle');
                            } else if (act === 'volume') {
                                toolResult = await setPhoneVolume({
                                    stream: fnArgs.volume_stream || 'media',
                                    percent: fnArgs.volume_percent,
                                    direction: fnArgs.volume_direction
                                });
                            } else if (act === 'ringer_mode') {
                                toolResult = await setPhoneRingerMode(fnArgs.ringer_mode || 'vibrate');
                            } else if (act === 'battery') {
                                toolResult = await getPhoneBatteryStatus();
                            } else if (act === 'open_app') {
                                const targetApp = (fnArgs.app_name || '').trim();
                                if (targetApp.toLowerCase() === 'youtube' && fnArgs.query) {
                                    const ytSearch = await searchYouTubeVideos(fnArgs.query, 3).catch(() => null);
                                    const topVid = ytSearch?.videos?.[0];
                                    const appRes = await openPhoneApp('youtube', fnArgs.query, topVid?.video_id);
                                    toolResult = {
                                        ...appRes,
                                        title: topVid?.title,
                                        channel: topVid?.channel,
                                        video_id: topVid?.video_id,
                                        url: topVid?.url || `https://www.youtube.com/results?search_query=${encodeURIComponent(fnArgs.query)}`
                                    };
                                } else {
                                    toolResult = await openPhoneApp(targetApp, fnArgs.query);
                                }
                            } else if (act === 'open_url') {
                                toolResult = await openExternalUrl(fnArgs.url || '');
                            } else {
                                toolResult = { error: `Onbekende telefoonactie: ${act}` };
                            }
                            actionsTaken.push({
                                type: 'phone_control',
                                entity_id: `phone.${act || 'control'}`,
                                service: `phone.${act || 'control'}`,
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'cooking_assistant') {
                            toolResult = executeCookingAssistant(fnArgs);
                            actionsTaken.push({
                                type: 'cooking',
                                entity_id: toolResult?.recipe_id || 'cooking.session',
                                service: `cooking.${fnArgs.action}`,
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'manage_google_docs') {
                            toolResult = await manageGoogleDocs(fnArgs);
                            actionsTaken.push({
                                type: 'google_docs',
                                entity_id: toolResult?.id || 'google.docs',
                                service: `docs.${fnArgs.action}`,
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'manage_google_sheets') {
                            toolResult = await manageGoogleSheets(fnArgs);
                            actionsTaken.push({
                                type: 'google_sheets',
                                entity_id: toolResult?.id || 'google.sheets',
                                service: `sheets.${fnArgs.action}`,
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'manage_email') {
                            toolResult = await manageGmail(fnArgs);
                            actionsTaken.push({
                                type: 'gmail',
                                entity_id: toolResult?.id || 'gmail',
                                service: `gmail.${fnArgs.action}`,
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'control_media_services') {
                            if (fnArgs.service === 'spotify') {
                                const cmd = (['status', 'play', 'pause', 'next', 'previous', 'volume'].includes(fnArgs.command)
                                    ? fnArgs.command
                                    : 'play') as 'status' | 'play' | 'pause' | 'next' | 'previous' | 'volume';
                                if (fnArgs.open_directly) {
                                    toolResult = await openPhoneApp('spotify', fnArgs.query);
                                } else {
                                    toolResult = await controlSpotify({
                                        command: cmd,
                                        query: fnArgs.query,
                                        volume_percent: fnArgs.volume_percent
                                    });
                                    // Smart fallback: if no active Spotify Connect device or Spotify OAuth isn't linked yet, open Spotify app directly!
                                    if ((toolResult?.no_active_device || toolResult?.needs_oauth) && cmd === 'play' && fnArgs.query) {
                                        const appRes = await openPhoneApp('spotify', fnArgs.query);
                                        if (appRes.success) {
                                            toolResult = {
                                                success: true,
                                                opened_app_fallback: true,
                                                query: fnArgs.query,
                                                message: `Spotify-app direct geopend voor "${fnArgs.query}".`
                                            };
                                        }
                                    }
                                }
                            } else {
                                // YouTube: resolve top video first, then immediately start playing it in the YouTube app!
                                const shouldAutoPlay = fnArgs.command === 'play' || fnArgs.command === 'open' || Boolean(fnArgs.open_directly);
                                if (shouldAutoPlay) {
                                    const searchRes = fnArgs.query ? await searchYouTubeVideos(fnArgs.query, 3).catch(() => null) : null;
                                    const topVideo = searchRes?.videos?.[0];
                                    const appRes = await openPhoneApp('youtube', fnArgs.query, topVideo?.video_id);
                                    toolResult = {
                                        ...appRes,
                                        ...(searchRes || {}),
                                        playing: Boolean(appRes?.playing || topVideo?.video_id),
                                        title: topVideo?.title || fnArgs.query,
                                        channel: topVideo?.channel,
                                        video_id: topVideo?.video_id,
                                        url: topVideo?.url || `https://www.youtube.com/results?search_query=${encodeURIComponent(fnArgs.query || '')}`
                                    };
                                } else {
                                    toolResult = await searchYouTubeVideos(fnArgs.query || '', 5);
                                }
                            }
                            actionsTaken.push({
                                type: fnArgs.service === 'spotify' ? 'spotify' : 'youtube',
                                entity_id: `media.${fnArgs.service}`,
                                service: `${fnArgs.service}.${fnArgs.command}`,
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'communicate_with_contact') {
                            toolResult = await communicateWithContact({
                                channel: fnArgs.channel || 'whatsapp',
                                contact_name: fnArgs.contact_name,
                                phone: fnArgs.phone,
                                message: fnArgs.message
                            });
                            actionsTaken.push({
                                type: 'communicate',
                                entity_id: `contact.${fnArgs.channel || 'whatsapp'}`,
                                service: `communicate.${fnArgs.channel || 'whatsapp'}`,
                                data: toolResult,
                                result: toolResult?.error ? 'error' : 'success',
                                executedLocally: true
                            });
                        } else if (fnName === 'create_home_assistant_automation') {
                            const draft = {
                                id: `butler_auto_${Date.now()}`,
                                alias: fnArgs.alias || 'Butler Automatisering',
                                description: fnArgs.description || '',
                                trigger: Array.isArray(fnArgs.trigger) ? fnArgs.trigger : [],
                                condition: Array.isArray(fnArgs.condition) ? fnArgs.condition : [],
                                action: Array.isArray(fnArgs.action) ? fnArgs.action : [],
                                mode: fnArgs.mode || 'single'
                            };
                            toolResult = { ...draft, ready_for_user_review: true };
                            actionsTaken.push({
                                type: 'automation',
                                entity_id: draft.id,
                                service: 'automation.create',
                                data: draft,
                                result: 'pending',
                                executedLocally: true
                            });
                        } else if (fnName === 'set_timer_or_alarm') {
                            if (fnArgs.kind === 'timer') {
                                const secs = Math.max(1, Number(fnArgs.duration_seconds) || 60);
                                actionsTaken.push({
                                    type: 'set_timer',
                                    entity_id: 'device.timer',
                                    service: 'timer.start',
                                    data: { duration: secs, message: fnArgs.label || 'Butler Timer' },
                                    result: 'success',
                                    executedLocally: false
                                });
                                toolResult = { success: true, kind: 'timer', duration_seconds: secs, label: fnArgs.label || 'Butler Timer' };
                            } else {
                                const hour = Number(fnArgs.hour);
                                const minute = Number(fnArgs.minute) || 0;
                                if (!Number.isFinite(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                                    toolResult = { error: 'Ongeldige wekkertijd (uur 0-23, minuut 0-59).' };
                                } else {
                                    actionsTaken.push({
                                        type: 'set_alarm',
                                        entity_id: 'device.alarm',
                                        service: 'alarm.set',
                                        data: { hour, minute, message: fnArgs.label || 'Butler Wekker' },
                                        result: 'success',
                                        executedLocally: false
                                    });
                                    toolResult = { success: true, kind: 'alarm', hour, minute, label: fnArgs.label || 'Butler Wekker' };
                                }
                            }
                        } else if (fnName === 'create_graph') {
                            const entityIds = Array.isArray(fnArgs.entity_ids) ? fnArgs.entity_ids : [];
                            const period = fnArgs.period || '24h';
                            const series = entityIds.map((eid: string) => ({
                                entity_id: eid,
                                label: options.devices.find(d => d.entity_id === eid)?.attributes?.friendly_name || eid
                            }));
                            actionsTaken.push({
                                type: 'create_graph',
                                entity_id: entityIds[0] || 'graph',
                                service: 'graph.create',
                                data: { title: fnArgs.title || 'Grafiek', period, series },
                                result: 'success',
                                executedLocally: false
                            });
                            toolResult = { success: true, title: fnArgs.title, period, entity_ids: entityIds };
                        } else if (fnName === 'run_proactive_worker') {
                            if (!options.connectionId) {
                                toolResult = { error: 'Geen actieve connectie om proactieve worker op uit te voeren.' };
                            } else {
                                const workerRes = await triggerProactiveWorker(
                                    fnArgs.worker as ProactiveWorkerId,
                                    options.connectionId,
                                    fnArgs.extra_params || {}
                                );
                                toolResult = workerRes;
                                actionsTaken.push({
                                    type: 'proactive_worker',
                                    entity_id: `worker.${fnArgs.worker}`,
                                    service: `worker.${fnArgs.worker}`,
                                    data: workerRes,
                                    result: workerRes.success ? 'success' : 'error',
                                    executedLocally: true
                                });
                            }
                        } else if (fnName === 'consult_deep_reasoner') {
                            const deepRes = await executeDeepReasonerTool(
                                fnArgs,
                                config,
                                options.language || 'nl-BE',
                                log
                            );
                            toolResult = deepRes;
                            if (!('error' in deepRes)) {
                                actionsTaken.push({
                                    type: 'deep_reasoning',
                                    entity_id: deepRes.model_used,
                                    service: `reasoning.${deepRes.depth}`,
                                    data: {
                                        model_used: deepRes.model_used,
                                        depth: deepRes.depth,
                                        elapsed_ms: deepRes.elapsed_ms
                                    },
                                    result: 'success',
                                    executedLocally: true
                                });
                            }
                        } else {
                            toolResult = { error: `Onbekende tool: ${fnName}` };
                        }
                    } catch (toolErr: any) {
                        toolResult = { error: toolErr?.message || String(toolErr) };
                    }

                    return { callId, fnName, result: toolResult };
                })
            );

            // Append pure JSON tool results (NO forced Dutch stop-instruction breaking multi-step plans!)
            for (const tr of toolResults) {
                messages.push({
                    role: 'tool',
                    tool_call_id: tr.callId,
                    name: tr.fnName,
                    content: JSON.stringify(tr.result)
                });
            }

            // If a camera snapshot was captured, attach it as a true multimodal image_url message!
            if (pendingVisionImages.length > 0) {
                const visionParts: any[] = [
                    { type: 'text', text: 'Hier zijn de opgehaalde live camerabeelden. Analyseer wat je ziet en beantwoord de vraag van de gebruiker.' }
                ];
                for (const img of pendingVisionImages) {
                    visionParts.push({
                        type: 'image_url',
                        image_url: { url: img.dataUrl }
                    });
                }
                messages.push({ role: 'user', content: visionParts });
            }

            continue;
        }

        // Natural language final answer
        finalResponseText = (assistantMsg.content || '').trim();
        log(`✅ ReAct finished in turn ${turn} (${finalResponseText.length} chars)`);
        break;
    }

    // If loop ended without text (e.g., hit MAX_TURNS after tool calls), ask LLM directly with tools disabled
    if (!finalResponseText) {
        log('🤖 Requesting final natural language synthesis from LLM...');
        messages.push({
            role: 'user',
            content: 'Geef nu direct een beknopt, natuurlijk antwoord aan de gebruiker op basis van alle opgehaalde gegevens.'
        });
        try {
            const { data } = await callLLMWithFailover(config, messages, false, log);
            finalResponseText = (data?.choices?.[0]?.message?.content || '').trim();
        } catch (e: any) {
            log(`❌ Final synthesis call error: ${e?.message}`);
        }
    }

    const parsedOutput = parseDualChannelResponse(finalResponseText);
    for (const card of parsedOutput.visualCards) {
        actionsTaken.push({
            type: 'visual_card',
            entity_id: card.title || 'visual_card',
            service: 'ui.visual_card',
            data: card,
            result: 'success',
            executedLocally: true
        });
    }

    const fallbackMsg = 'Ik kon geen antwoord genereren. Probeer het nog eens.';
    return {
        text: parsedOutput.displayText || fallbackMsg,
        spoken_text: parsedOutput.spokenText || parsedOutput.displayText || fallbackMsg,
        actions: actionsTaken,
        language: options.language || 'nl',
        confidence: 1.0,
        logs: executionLogs
    };
}
