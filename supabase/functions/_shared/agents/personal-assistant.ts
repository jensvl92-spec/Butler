/**
 * Personal Assistant Agent
 * 
 * Handles personal life management: Calendar, Email, Weather, Music, Navigation, Tasks.
 * Delegates from Butler when request is about personal matters rather than device control.
 */

import { groqMainCompletion, parseJSONResponse } from '../llm-service.ts';
import { getCurrentWeather, getForecast, formatWeatherText, willItRain } from '../services/weather-service.ts';
import { getETAFromCoords, formatETAText, resolveDestination } from '../services/maps-service.ts';
import { searchAndPlay, pause, next, previous, getPlaybackState } from '../services/spotify-service.ts';
import { getUpcomingEvents, createEvent, updateEvent, deleteEvent } from '../services/calendar-service.ts';
import { getUnreadEmails, sendEmail } from '../services/email-service.ts';
import { searchYouTubeMusic } from '../services/youtube-service.ts';
import { listSpreadsheets, getSpreadsheetData, updateSpreadsheetData, appendSpreadsheetData, createSpreadsheet, createChart, formatCells, addBorders, freezeRowsOrColumns, mergeCells, autoResizeColumns } from '../services/sheets-service.ts';
import { getTasks, createTask, completeTask, deleteTask, getTaskLists, createTaskList } from '../services/tasks-service.ts';
import { listDocuments, getDocument, createDocument, appendToDocument } from '../services/docs-service.ts';

/**
 * Extract clean search terms from a user message.
 */
async function extractSearchQuery(message: string, log: (msg: string) => void): Promise<string> {
    log(`[PersonalAssistant] Extracting smart query from: "${message}"`);
    const prompt = `Extract ONLY the music artist and/or song title from the user's request. 
Remove filler words like "speel", "zet op", "op YouTube", "gratis", "smartphone", "telefoon", "mijn", "af", "wat", etc.
Return ONLY the clean search terms.
Example: "Speel Ludovico Einaudi af op mijn telefoon" -> "Ludovico Einaudi"
Example: "Zet Bohemian Rhapsody van Queen aan" -> "Bohemian Rhapsody Queen"
Request: "${message}"`;

    const result = await groqMainCompletion([
        { role: 'system', content: 'You are a precise music query extractor. Return only the cleaned search terms.' },
        { role: 'user', content: prompt }
    ], 50, 0.1);

    const query = result.trim().replace(/^["']|["']$/g, '');
    log(`[PersonalAssistant] Extracted Query: "${query}"`);
    return query;
}

const PERSONAL_ASSISTANT_PROMPT = `
IDENTITY:
You are a highly organized executive personal assistant. You help with daily life management.

CAPABILITIES:
1. **Weather** - You have access to real weather data. Use it when user asks about weather.
2. **Navigation** - You have access to real ETA data AND can open Google Maps for turn-by-turn navigation.
3. **Calendar** - You can check your schedule and create events. Use calendarData context.
4. **Email** - You can check your unread emails and send new ones. Use emailData context.
5. **Music** - Control Spotify (Premium) OR YouTube Music (Free).
6. **Google Sheets** - Full spreadsheet control: create, read, update, append data, create charts (pie/bar/line/column), format cells (bold, colors, alignment), add formulas (=SUM, =AVERAGE, etc.), merge cells, add borders, freeze headers.
7. **Google Tasks** - Read and manage to-do lists and tasks (e.g., Shopping List). Use keepData context.
8. **Google Docs** - Read and create documents. Use docsData context.
9. **Messaging** - Send WhatsApp messages or SMS texts via deep linking.
10. **Expense Tracking** - Log expenses to a spreadsheet with natural language.
11. **Meeting Prep** - Create meeting notes documents automatically.
12. **Translation** - Translate text with high accuracy, handling gender and context intelligently.

=== ACTION TYPES ===

**Navigation**:
{ "action": "open_navigation", "parameters": { "destination": "Amsterdam Central Station", "mode": "driving" } }
Modes: "driving" (default), "walking", "bicycling"
IMPORTANT: ALWAYS ask for confirmation before including this action.

**WhatsApp Message** (CLIENT-SIDE - ALWAYS WORKS):
{ "action": "open_whatsapp", "parameters": { "name": "SchatjeL", "text": "Hoi, ik hou van je!" } }
Use when user says "app", "whatsapp", "message [person]", "tell [person] that...", "stuur [person]", "berichtje naar".
If the user mentions a contact name, use the "name" parameter. The CLIENT APP will look up the phone number from contacts.
⚠️ YOU HAVE FULL WHATSAPP ACCESS. NEVER say you can't send messages. NEVER apologize. ALWAYS generate the action.
⚠️ The message WILL be sent. Just generate the action and confirm you're sending it.

**SMS Text** (CLIENT-SIDE - ALWAYS WORKS):
{ "action": "open_sms", "parameters": { "name": "Mom", "text": "On my way!" } }
Use when user explicitly says "text" or "sms".
⚠️ Same rules as WhatsApp: ALWAYS works via client-side. NEVER say you can't.

**Line Message**:
{ "action": "open_line", "parameters": { "text": "I'll be there soon!" } }
Use when user says "Line", "send via Line", "message on Line". Opens the Line app's share screen with a pre-filled message.

**Open URL** (for YouTube, Docs, Sheets, etc.):
{ "action": "open_url", "parameters": { "url": "https://..." } }

**Playback on HA Speaker**:
{ "action": "media_player.play_media", "entity_id": "media_player.living_room", "parameters": { "media_content_id": "...", "media_content_type": "music" } }
Available media players: {{mediaPlayers}}

**Google Sheets Actions**:

Append Row (also creates spreadsheet if not found):
{ "action": "append_spreadsheet", "parameters": { "title": "Expenses 2026", "sheetName": "Sheet1", "values": [["2026-01-01", "Category", 100, "Description"]] } }

Create Chart (types: pie, bar, line, column, area):
{ "action": "create_chart", "parameters": { "title": "Expense Tracker", "chartType": "pie", "chartTitle": "Monthly Expenses", "dataRange": { "startRow": 0, "endRow": 10, "startCol": 0, "endCol": 2 } } }

Format Cells (bold, colors, alignment):
{ "action": "format_cells", "parameters": { "title": "Expenses 2026", "range": { "startRow": 0, "endRow": 1, "startCol": 0, "endCol": 4 }, "format": { "bold": true, "backgroundColor": { "red": 0.2, "green": 0.6, "blue": 0.9 } } } }

Add Borders:
{ "action": "add_borders", "parameters": { "title": "Expenses 2026", "range": { "startRow": 0, "endRow": 10, "startCol": 0, "endCol": 4 }, "style": "SOLID" } }

Freeze Header Row:
{ "action": "freeze_rows", "parameters": { "title": "Expenses 2026", "frozenRows": 1 } }

**Google Docs Actions**:

Create Document:
{ "action": "create_document", "parameters": { "title": "My Story", "content": "Once upon a time..." } }

Append Text:
{ "action": "append_to_document", "parameters": { "documentId": "...", "text": "Chapter 1..." } }


=== SPECIAL PROTOCOLS ===

**Translation Logic** (triggered by "Translate...", "Vertaal...", "How do you say..."):
1. **NO Phonetics**: Never provide phonetic pronunciation (like "kon-nee-chee-wa") unless explicitly asked. Just give the clean translated text.
2. **Gender/Context Check**: If the target language is gendered (e.g., French, Spanish, Dutch, German, Italian, Portuguese) AND the source text is ambiguous (e.g., "friend", "teacher", "they", "happy"):
   - STOP immediately.
   - Do NOT guess.
   - ASK the user for clarification (e.g., "Is the friend male or female?", "Is this addressing a man or a woman?").
   - ONLY translate once you have this confirmation.

**Meaningful Messaging** (triggered by "Send message", "App", "Text", "Line"):
1. **Exclusivity**: Use ONLY ONE app per request.
   - If user says "via Line" -> Use open_line ONLY.
   - If user says "via WhatsApp" -> Use open_whatsapp ONLY.
   - If user says "via SMS" -> Use open_sms ONLY.
   - **NEVER** generate multiple messaging actions for the same request.
2. **Default App**: If no app is specified (e.g., "Send message to..."), default to **WhatsApp** (open_whatsapp).
3. **Line Limitation**: Line open_line ONLY supports the text parameter. It CANNOT select a contact (name).
   - Correct: { "action": "open_line", "parameters": { "text": "Hello" } }
   - Incorrect: { ... "name": "John" ... } -> The name will be ignored by the client on Line.

**Daily Briefing** (triggered by "Good morning", "Briefing", "What's on today?"):
When the user greets you in the morning or asks for a briefing:
1. Start with a warm greeting and the weather summary
2. List today's calendar events with times
3. Mention any unread important emails
4. If there's a meeting with a location, mention travel time
5. Be conversational and helpful, like a real executive assistant

**Smart Shopping** (triggered by "Add ingredients for [dish]" or "Add X to shopping list"):
When user asks to add items to their shopping list:
1. Think about what items/ingredients are needed
2. Create MULTIPLE separate "create_task" actions, one for each item
3. IMPORTANT: Use list="Shopping List" (or the user's shopping list name from keepData context)
4. Do NOT use the default task list for shopping items
Example: "Add ingredients for spaghetti bolognese" creates tasks for: pasta, ground beef, tomato sauce, onion, garlic
{ "action": "create_task", "parameters": { "title": "Pasta", "list": "Shopping List" } }

**Expense Logging** (triggered by "I spent...", "Logged...", "Bought..."):
When user reports an expense:
1. Extract: amount, category (food/transport/shopping/bills/entertainment/other), description, date (default: today)
2. Use "append_spreadsheet" action to add a row to the user's Expenses spreadsheet
3. Format: [[date, category, amount, description]]
If no Expenses spreadsheet exists, offer to create one first.

**Meeting Prep** (triggered by "Prep for...", "Create notes for... meeting"):
When user asks to prepare for a meeting:
1. Identify the meeting from calendar context (by time or title)
2. Create a new Google Doc with title: "Notes: [Meeting Title] - [Date]"
3. The doc should include template sections: Attendees, Agenda, Discussion Points, Action Items
4. Return the doc link so user can open it

**Calendar Management**:
{ "action": "create_event", "parameters": { "title": "Meeting with John", "date": "2026-01-12", "time": "14:00", "duration": 60 } }
- Use "datetime" (ISO) or separate "date" (YYYY-MM-DD) and "time" (HH:MM) fields.
- Duration is in minutes (default 60).

**Task Management**:
{ "action": "create_task", "parameters": { "title": "Buy Milk", "list": "Shopping List", "due": "2026-01-12" } }
- Use "list" to specify the target list (e.g., "Shopping List", "Work").
- Default list is "My Tasks" if not specified.

**Request GPS Location**:
{ "action": "request_gps", "parameters": {} }
Only REQUEST GPS if the response would greatly improve with location right now.
If location is already provided, you can USE it freely. This rule is about when to ASK for it.

=== CRITICAL RULES ===

- Every action MUST include an "action" string and "parameters" object.
- **YouTube/Docs URLs**: ONLY use URLs provided in the context or returned by creation actions. NEVER invent URLs.
- **Creation Rule**: To create a document/sheet, use \`create_document\` or \`create_spreadsheet\`. DO NOT pretend to create it and return a fake URL.
- Keep responses concise and helpful.
- **Location Rule**: Only request GPS if the user's current task REQUIRES location to complete. Ask yourself: "Does this task need to know WHERE the user is?" If no, proceed without GPS.

OUTPUT FORMAT:
{
  "text": "Your conversational response here.",
  "actions": [
    { "action": "action_type", "parameters": { ... } }
  ]
}
`;

export interface PersonalAssistantResult {
    text: string;
    actions: Array<any>;
    data?: Record<string, any>;
}

export interface UserLocation {
    lat: number;
    lon: number;
}

/**
 * Run the Personal Assistant agent.
 */
export async function runPersonalAssistant(
    message: string,
    context: string,
    mcpProxyUrl: string,
    userId: string,
    language: string = 'en',
    location?: UserLocation | null,
    intentType?: string,
    log: (msg: string) => void = () => { },
    history: any[] = [],
    clientTimestamp?: string,
    clientTimezone?: string,
    gpsUnavailable: boolean = false
): Promise<PersonalAssistantResult> {
    log(`[PersonalAssistant] Processing: "${message}"`);
    log(`[PersonalAssistant] Location: ${location ? `${location.lat}, ${location.lon}` : 'null'}${gpsUnavailable ? ' (GPS unavailable)' : ''}`);

    // Use client time if provided, otherwise fallback to server time
    const currentTime = clientTimestamp || new Date().toISOString();
    const timezone = clientTimezone || 'UTC';
    const languageNote = language !== 'en'
        ? `\n\nIMPORTANT: Respond in ${language}.`
        : '';

    // Gather real data based on intent
    let weatherData = '';
    let navigationData = '';
    let musicData = '';
    let musicActionResponse = '';
    let calendarData = '';
    let calendarActionResponse = '';
    let emailData = '';
    let emailActionResponse = '';
    let youtubeData = '';
    let youtubeActionResponse = '';
    let mediaPlayers = '';
    let sheetsData = '';
    let sheetsActionResponse = '';
    let keepData = '';
    let keepActionResponse = '';
    let docsData = '';
    let docsActionResponse = '';

    // Daily Briefing detection - fetch weather, calendar, and email together
    const isDailyBriefing = message.toLowerCase().match(/good morning|goedemorgen|briefing|what's on today|wat staat er vandaag|morning update|ochtend update/);

    // Weather request (also triggered by daily briefing)
    if (intentType === 'weather' || isDailyBriefing || message.toLowerCase().match(/weer|weather|regen|rain|zon|sun|temperatuur|temperature|forecast|voorspelling/)) {
        if (location) {
            try {
                log('[PersonalAssistant] Fetching weather...');
                const weather = await getCurrentWeather(location.lat, location.lon, language === 'nl' || language === 'nl-BE' ? 'nl' : 'en');
                const forecast = await getForecast(location.lat, location.lon, language === 'nl' || language === 'nl-BE' ? 'nl' : 'en');
                const rain = willItRain(forecast);

                weatherData = `
REAL WEATHER DATA:
Current: ${formatWeatherText(weather, language)}
Forecast: ${forecast.days.map(d => `${d.date}: ${d.temp_min}-${d.temp_max}°C, ${d.description}`).join('; ')}
Rain probability: Today ${rain.today ? 'Yes' : 'No'}, Tomorrow ${rain.tomorrow ? 'Yes' : 'No'}
`;
                log('[PersonalAssistant] Got weather data');
            } catch (e: any) {
                log(`[PersonalAssistant] Weather error: ${e.message}`);
                weatherData = '\n(Weather data unavailable)';
            }
        } else {
            log('[PersonalAssistant] No location for weather');
            weatherData = '\n(No location available for weather)';
        }
    }

    // Navigation request (Only if relevant intent)
    const looksLikeNavigation = message.toLowerCase().match(/hoe lang|how long|eta|route|rijden|drive|ga naar|go to/i);
    const destMatch = message.match(/(?:naar|to)\s+([^?.!,;]+(?!\som\s\d|\svan\d|\stegen\d))/i);
    const destination = destMatch ? destMatch[1].trim() : null;

    if (location && destination && (intentType === 'navigation' || looksLikeNavigation)) {
        log(`[PersonalAssistant] Destination extracted: "${destination}"`);
        try {
            // Resolve relative destinations ("closest X") using Places API
            const resolved = await resolveDestination(location.lat, location.lon, destination);
            const finalDestination = resolved.resolved;

            if (resolved.isRelative) {
                log(`[PersonalAssistant] Resolved "${destination}" → "${finalDestination}"`);
            }

            log(`[PersonalAssistant] Fetching ETA to ${finalDestination}...`);
            const eta = await getETAFromCoords(location.lat, location.lon, finalDestination, 'driving', language === 'nl' || language === 'nl-BE' ? 'nl' : 'en');
            navigationData = `\nREAL NAVIGATION DATA:\n${formatETAText(eta, language)}`;
            log('[PersonalAssistant] Got navigation data');
        } catch (e: any) {
            log(`[PersonalAssistant] Navigation error: ${e.message}`);
            navigationData = `\n(Could not get directions to "${destination}")`;
        }
    }

    // Calendar request (also triggered by daily briefing)
    if (intentType === 'calendar' || isDailyBriefing || message.toLowerCase().match(/agenda|kalender|calendar|afspraak|meeting|schedule|planning|event|gebeurtenis/)) {
        try {
            log('[PersonalAssistant] Processing calendar request...');

            // Check for creating/updating/deleting event
            if (message.toLowerCase().match(/maak|zet|voeg|create|add|plan|verzet|update|verwijder|delete/)) {
                // LLM will handle the action generation
                calendarActionResponse = "\n(I can help you with this calendar request)";
            } else {
                // Default: Fetch upcoming
                const events = await getUpcomingEvents(userId, 5);
                if (events && events.length > 0) {
                    calendarData = `\nUPCOMING EVENTS:\n${events.map((e: any) => `- ${e.summary} (${new Date(e.start).toLocaleString()}) [ID: ${e.id}]`).join('\n')}`;
                    calendarActionResponse = language === 'nl' ? `Je hebt ${events.length} komende afspraken.` : `You have ${events.length} upcoming events.`;
                } else {
                    calendarActionResponse = language === 'nl' ? 'Je agenda is momenteel leeg.' : 'Your calendar is currently empty.';
                }
            }
        } catch (e: any) {
            log(`[PersonalAssistant] Calendar error: ${e.message}`);
            calendarActionResponse = `(Calendar error: ${e.message})`;
        }
    }

    // Identify media players for the prompt
    if (context) {
        const playerMatches = context.match(/media_player\.[a-z0-9_]+/g);
        if (playerMatches) {
            mediaPlayers = [...new Set(playerMatches)].join(', ');
        }
    }

    // Email request (also triggered by daily briefing)
    if (intentType === 'email' || isDailyBriefing || message.toLowerCase().match(/mail|email|bericht|stuur naar|gmail/)) {
        try {
            log('[PersonalAssistant] Processing email request...');

            // Check for sending email
            if (message.toLowerCase().match(/stuur|verzend|mail naar|email to|write to/)) {
                // Extract to, subject, body from message
                const emailMatch = message.match(/(?:stuur|mail|email)\s+(?:naar\s+)?([^\s@]+@[^\s@]+\.[^\s@]+)(?:\s+over\s+)?([^.?!]*)(?:\s+dat\s+)?(.+)?/i);
                if (emailMatch) {
                    const to = emailMatch[1].trim();
                    const subject = emailMatch[2].trim() || 'Bericht van Butler';
                    const body = emailMatch[3]?.trim() || 'Hoi, dit is een bericht verzonden via mijn assistent.';

                    log(`[PersonalAssistant] Sending email to ${to}...`);
                    await sendEmail(userId, to, subject, body);
                    emailActionResponse = language === 'nl' ? `E-mail verzonden naar ${to}.` : `Email sent to ${to}.`;
                } else {
                    emailActionResponse = language === 'nl' ? "Ik heb een e-mailadres nodig om een bericht te sturen." : "I need an email address to send a message.";
                }
            } else {
                // Fetch unread
                const emails = await getUnreadEmails(userId, 5);
                if (emails && emails.length > 0) {
                    emailData = `\nUNREAD EMAILS:\n${emails.map((e: any) => `- Van: ${e.from}\n  Onderwerp: ${e.subject}\n  Snippet: ${e.snippet}`).join('\n')}`;
                    emailActionResponse = language === 'nl' ? `Je hebt ${emails.length} nieuwe e-mails.` : `You have ${emails.length} new emails.`;
                } else {
                    emailActionResponse = language === 'nl' ? 'Je hebt geen ongelezen e-mails.' : 'You have no unread emails.';
                }
            }
        } catch (e: any) {
            log(`[PersonalAssistant] Email error: ${e.message}`);
            emailActionResponse = `(Email error: ${e.message})`;
        }
    }

    // Music request
    if (intentType === 'music' || message.toLowerCase().match(/spotify|muziek|music|play|speel|pause|pauze|next|volgende|skip|previous|vorige/)) {
        try {
            log('[PersonalAssistant] Processing music request...');

            // Get current state first
            if (message.toLowerCase().match(/wat speel|what playing|nummer|song/)) {
                const state = await getPlaybackState(userId);
                if (state && state.is_playing) {
                    musicData = `\nNOW PLAYING: "${state.track}" by ${state.artist} on ${state.device} (Vol: ${state.volume}%)`;
                    musicActionResponse = language === 'nl' ? `Er speelt nu "${state.track}" van ${state.artist}.` : `Now playing "${state.track}" by ${state.artist}.`;
                } else {
                    musicActionResponse = language === 'nl' ? 'Er speelt momenteel niets op Spotify.' : 'Nothing is currently playing on Spotify.';
                }
            }
            // Control commands
            else if (message.toLowerCase().match(/pause|pauze|stop/)) {
                musicActionResponse = await pause(userId);
            } else if (message.toLowerCase().match(/next|volgende|skip/)) {
                musicActionResponse = await next(userId);
            } else if (message.toLowerCase().match(/previous|vorige|back/)) {
                musicActionResponse = await previous(userId);
            } else if (message.toLowerCase().match(/play|speel|zet/)) {
                // Check if user explicitly wants YouTube/Free OR if likely on mobile (where YT is more accessible)
                const useYouTubeByDefault = message.toLowerCase().match(/youtube|vrij|gratis|free|smartphone|telefoon|phone|mobiel|mobile|gsm/);

                // Get clean query for both
                const query = await extractSearchQuery(message, log);

                if (useYouTubeByDefault) {
                    log(`[PersonalAssistant] Direct YouTube search for "${query}"...`);
                    const ytResults = await searchYouTubeMusic(userId, query, log);
                    if (ytResults && Array.isArray(ytResults) && ytResults.length > 0) {
                        youtubeData = `\nFOUND ON YOUTUBE (Top 3):\n${ytResults.map((r: any, i: number) => `MATCH ${i + 1}: Artist/Title: "${r.title}" (URL: ${r.url}) [AppLink: ${r.appLink}]`).join('\n')}\n(Strictly pick the best match. Use open_url with appLink for phone, or media_player.play_media for Home Assistant)`;
                        youtubeActionResponse = language === 'nl' ? `Ik heb ${ytResults.length} opties gevonden op YouTube Music.` : `Found ${ytResults.length} options on YouTube Music.`;
                    } else {
                        youtubeData = `\nNO YOUTUBE MUSIC RESULTS FOUND for: "${query}"`;
                        youtubeActionResponse = language === 'nl' ? 'Ik kon dit niet vinden op YouTube Music.' : 'I couldn\'t find this on YouTube Music.';
                    }
                } else {
                    // Try Spotify first
                    log(`[PersonalAssistant] Trying Spotify search for "${query}"...`);
                    try {
                        const spotRes = await searchAndPlay(userId, query, log);

                        // Check if success (usually returns a confirmation text)
                        if (spotRes && !spotRes.includes('error') && !spotRes.includes('Premium required')) {
                            musicActionResponse = spotRes;
                        } else {
                            // Spotify failed (likely Premium or no active device) -> FALLBACK TO YOUTUBE
                            log(`[PersonalAssistant] Spotify failed (${spotRes}), falling back to YouTube...`);
                            const ytResults = await searchYouTubeMusic(userId, query, log);
                            if (ytResults && Array.isArray(ytResults) && ytResults.length > 0) {
                                youtubeData = `\n(Spotify Unavailable: Falling back to YouTube)\nFOUND ON YOUTUBE (Top 3):\n${ytResults.map((r: any, i: number) => `MATCH ${i + 1}: Artist/Title: "${r.title}" (URL: ${r.url}) [AppLink: ${r.appLink}]`).join('\n')}\n(Pick the best match. Inform user Spotify failed and you found it on YT Music.)`;
                                youtubeActionResponse = language === 'nl' ? 'Spotify is niet beschikbaar, ik heb het op YouTube gevonden.' : 'Spotify unavailable, found it on YouTube Music instead.';
                            } else {
                                musicActionResponse = spotRes; // Stay with Spotify error if YT also fails
                            }
                        }
                    } catch (err: any) {
                        log(`[PersonalAssistant] Spotify exception, falling back to YouTube...`);
                        const ytResults = await searchYouTubeMusic(userId, query, log);
                        if (ytResults && Array.isArray(ytResults) && ytResults.length > 0) {
                            youtubeData = `\n(Spotify Error: ${err.message})\nFOUND ON YOUTUBE:\n${ytResults.map((r: any, i: number) => `MATCH ${i + 1}: "${r.title}" (URL: ${r.url})`).join('\n')}`;
                        } else {
                            musicActionResponse = `(Error: ${err.message})`;
                        }
                    }
                }
            }

            // Always fetch state context for the LLM if we used Spotify
            if (!youtubeData) {
                const finalState = await getPlaybackState(userId);
                if (finalState && finalState.is_playing) {
                    musicData = `\nSPOTIFY STATE: Playing "${finalState.track}" by ${finalState.artist}`;
                } else {
                    musicData = `\nSPOTIFY STATE: Not playing`;
                }
            }

        } catch (e: any) {
            log(`[PersonalAssistant] Music error: ${e.message}`);
            musicActionResponse = `(Spotify error: ${e.message})`;
        }
    }

    // Google Sheets request
    if (intentType === 'sheets' || message.toLowerCase().match(/spreadsheet|sheets|google sheets|excel|tabel|werkblad/)) {
        try {
            log('[PersonalAssistant] Processing Sheets request...');

            // Check for creating a spreadsheet
            if (message.toLowerCase().match(/maak|create|nieuw|new/)) {
                sheetsActionResponse = language === 'nl'
                    ? "(Ik kan een nieuw spreadsheet voor je maken)"
                    : "(I can create a new spreadsheet for you)";
            } else {
                // Default: List spreadsheets
                const sheets = await listSpreadsheets(userId, 5);
                if (sheets && sheets.length > 0) {
                    sheetsData = `\nYOUR SPREADSHEETS:\n${sheets.map((s: any) => `- ${s.name} [ID: ${s.id}] (Modified: ${new Date(s.modifiedTime).toLocaleDateString()})`).join('\n')}`;
                    sheetsActionResponse = language === 'nl'
                        ? `Je hebt ${sheets.length} spreadsheets gevonden.`
                        : `Found ${sheets.length} spreadsheets.`;
                } else {
                    sheetsActionResponse = language === 'nl'
                        ? 'Je hebt geen spreadsheets.'
                        : 'You have no spreadsheets.';
                }
            }
        } catch (e: any) {
            log(`[PersonalAssistant] Sheets error: ${e.message}`);
            sheetsActionResponse = `(Sheets error: ${e.message})`;
        }
    }

    // Google Tasks request (alternative to Keep for notes/tasks)
    if (intentType === 'tasks' || message.toLowerCase().match(/task|taak|taken|todo|to-do|onthoud|remember|boodschappen|shopping list|lijstje/)) {
        try {
            log('[PersonalAssistant] Processing Tasks request...');

            // Check for creating a task
            if (message.toLowerCase().match(/maak|create|nieuw|new|schrijf|write|voeg toe|add/)) {
                keepActionResponse = language === 'nl'
                    ? "(Ik kan een nieuwe taak voor je maken)"
                    : "(I can create a new task for you)";
            } else {
                // Default: List tasks and task lists
                const lists = await getTaskLists(userId);
                const tasks = await getTasks(userId, '@default', 5);

                const listsInfo = lists.map((l: any) => `- ${l.title} [ID: ${l.id}]`).join('\n');
                keepData = `\nYOUR TASK LISTS:\n${listsInfo}\n\nTASKS (Default List):\n${tasks.map((t: any) => `- ${t.title}${t.notes ? ': ' + t.notes : ''} [ID: ${t.id}]`).join('\n')}`;

                keepActionResponse = language === 'nl'
                    ? `Je hebt ${tasks.length} taken en ${lists.length} lijsten gevonden.`
                    : `Found ${tasks.length} tasks across ${lists.length} lists.`;
            }
        } catch (e: any) {
            log(`[PersonalAssistant] Tasks error: ${e.message}`);
            keepActionResponse = `(Tasks error: ${e.message})`;
        }
    }

    // Google Docs request
    if (intentType === 'docs' || message.toLowerCase().match(/document|docs|google docs|word|tekst|schrijven|writing/)) {
        try {
            log('[PersonalAssistant] Processing Docs request...');

            // Check for creating a document
            if (message.toLowerCase().match(/maak|create|nieuw|new/)) {
                docsActionResponse = language === 'nl'
                    ? "(Ik kan een nieuw document voor je maken)"
                    : "(I can create a new document for you)";
            } else {
                // Default: List documents
                const docs = await listDocuments(userId, 5);
                if (docs && docs.length > 0) {
                    docsData = `\nYOUR DOCUMENTS:\n${docs.map((d: any) => `- ${d.name} [ID: ${d.id}] (Modified: ${new Date(d.modifiedTime).toLocaleDateString()})`).join('\n')}`;
                    docsActionResponse = language === 'nl'
                        ? `Je hebt ${docs.length} documenten gevonden.`
                        : `Found ${docs.length} documents.`;
                } else {
                    docsActionResponse = language === 'nl'
                        ? 'Je hebt geen documenten.'
                        : 'You have no documents.';
                }
            }
        } catch (e: any) {
            log(`[PersonalAssistant] Docs error: ${e.message}`);
            docsActionResponse = `(Docs error: ${e.message})`;
        }
    }

    // Build location context for LLM
    let locationContext: string;
    if (location) {
        locationContext = `\nLOCATION: ${location.lat.toFixed(6)}, ${location.lon.toFixed(6)} (GPS available - DO NOT request_gps)`;
    } else if (gpsUnavailable) {
        locationContext = '\nLOCATION: null (GPS UNAVAILABLE - client cannot get location. DO NOT request_gps. Proceed without location or ask user to provide address manually.)';
    } else {
        // No location - LLM should only request GPS if it would greatly improve the response
        locationContext = '\nLOCATION: null (GPS not yet available - only request_gps if it would greatly improve your response right now)';
    }

    // Use Groq 70B for fast, high-quality response
    const response = await groqMainCompletion([
        { role: 'system', content: PERSONAL_ASSISTANT_PROMPT.replace('{{mediaPlayers}}', mediaPlayers || 'None available') + languageNote },
        ...history,
        { role: 'user', content: `CURRENT TIME: ${currentTime} (${timezone})${locationContext}\nCONTEXT: ${context}${weatherData}${navigationData}${musicData}${calendarData}${emailData}${youtubeData}${sheetsData}${keepData}${docsData}\nACTION RESULTS:\nMusic: ${musicActionResponse}\nCalendar: ${calendarActionResponse}\nEmail: ${emailActionResponse}\nYouTube: ${youtubeActionResponse}\nSheets: ${sheetsActionResponse}\nKeep: ${keepActionResponse}\nDocs: ${docsActionResponse}\n\nREQUEST: ${message}` }
    ], 5000, 0.5);

    const result = parseJSONResponse(response) as any;

    if (result) {
        // CORRECTION: Check if 'text' itself is a stringified JSON object (LLM Hallucination fix)
        // Sometimes the LLM puts the entire JSON object inside the "text" field recursively.
        if (typeof result.text === 'string' && result.text.trim().startsWith('{')) {
            try {
                const nested = JSON.parse(result.text);
                if (nested.text) {
                    result.text = nested.text; // Unwrap the real text
                    // Merge any nested actions found inside the text
                    if (nested.actions && Array.isArray(nested.actions)) {
                        // IMPORTANT: Replace (not merge) to prevent duplication if LLM included actions in both places
                        result.actions = nested.actions;
                    }
                }
            } catch (e) {
                // Not JSON, ignore
            }
        }

        log(`[PersonalAssistant] Result text: ${result.text}`);

        // SERVER-SIDE SERVICE EXECUTION
        if (result.actions && result.actions.length > 0) {
            // Cache for spreadsheet IDs (by title) - persists across actions in this request
            const spreadsheetCache: Record<string, string> = {};

            for (const action of result.actions) {
                try {
                    const type = (action.type || action.action || '').toLowerCase();
                    const data = action.data || action.parameters || action;

                    if (type === 'createevent' || type === 'create_event') {
                        const title = data.title || data.summary || data.name;
                        log(`[PersonalAssistant] Executing server-side createEvent: ${title}`);
                        const startTime = (data.date && data.time) ? `${data.date}T${data.time}` : (data.startTime || data.datetime);
                        if (startTime) {
                            await createEvent(userId, title, startTime, data.duration || 60, clientTimezone);
                            log('[PersonalAssistant] ✅ Calendar event created');
                        }
                    } else if (type === 'updateevent' || type === 'update_event' || type === 'update_event_time') {
                        const title = data.title || data.summary || data.name;
                        log(`[PersonalAssistant] Executing server-side updateEvent: ${title}`);

                        let eventId = data.id || data.eventId || data.event_id;
                        if (!eventId) {
                            log('[PersonalAssistant] No ID provided for update, searching...');
                            const events = await getUpcomingEvents(userId, 10);
                            const found = events.find((e: any) =>
                                (e.summary || '').toLowerCase().includes((title || '').toLowerCase()) ||
                                (title || '').toLowerCase().includes((e.summary || '').toLowerCase())
                            );
                            if (found) {
                                eventId = found.id;
                                log(`[PersonalAssistant] Found existing event ID: ${eventId}`);
                            }
                        }

                        if (eventId) {
                            const newTime = data.new_datetime || data.datetime || (data.date && data.time ? `${data.date}T${data.time}` : data.startTime);
                            if (newTime) {
                                await updateEvent(userId, eventId, title, newTime, data.duration || 60);
                                log('[PersonalAssistant] ✅ Calendar event updated');
                            }
                        } else {
                            log('[PersonalAssistant] ⚠️ Could not find event to update');
                        }
                    } else if (type === 'deleteevent' || type === 'delete_event') {
                        log(`[PersonalAssistant] Executing server-side deleteEvent`);
                        let eventId = data.id || data.eventId || data.event_id;
                        if (!eventId) {
                            const title = data.title || data.summary || data.name;
                            const events = await getUpcomingEvents(userId, 10);
                            const found = events.find((e: any) =>
                                (e.summary || '').toLowerCase().includes((title || '').toLowerCase()) ||
                                (title || '').toLowerCase().includes((e.summary || '').toLowerCase())
                            );
                            if (found) eventId = found.id;
                        }

                        if (eventId) {
                            await deleteEvent(userId, eventId);
                            log('[PersonalAssistant] ✅ Calendar event deleted');
                        }
                    } else if (type === 'sendemail' || type === 'send_email') {
                        log(`[PersonalAssistant] Executing server-side sendEmail to ${data.to}`);
                        await sendEmail(userId, data.to, data.subject, data.body);
                        log('[PersonalAssistant] ✅ Email sent');
                    } else if (type === 'media_player.play_media' || type === 'play_media') {
                        const entityId = action.entity_id || data.entity_id;
                        if (entityId) {
                            log(`[PersonalAssistant] Forwarding play_media to Home Assistant for ${entityId}`);
                        } else {
                            log('[PersonalAssistant] ⚠️ Missing entity_id for play_media');
                        }
                    }
                    // === GOOGLE TASKS ACTIONS ===
                    else if (type === 'createtask' || type === 'create_task' || type === 'add_task' || type === 'add_to_list') {
                        const title = data.title || data.text || data.name;
                        const listName = data.list || data.listName || 'Shopping List';
                        log(`[PersonalAssistant] Executing server-side createTask: ${title} (List: ${listName})`);

                        // Find or create list ID
                        let listId = '@default';
                        if (listName && listName !== 'My Tasks' && listName !== 'Tasks') {
                            const lists = await getTaskLists(userId);
                            const foundList = lists.find((l: any) => l.title.toLowerCase() === listName.toLowerCase());
                            if (foundList) {
                                listId = foundList.id;
                            } else {
                                log(`[PersonalAssistant] Creating new task list: ${listName}`);
                                const newList = await createTaskList(userId, listName);
                                listId = newList.id;
                            }
                        }

                        const task = await createTask(userId, title, data.notes, data.due, listId);
                        log(`[PersonalAssistant] ✅ Task created: ${task.title} in list ${listName}`);
                        result.text += language === 'nl'
                            ? `\n(Toegevoegd: ${task.title})`
                            : `\n(Added: ${task.title})`;
                    } else if (type === 'createtasklist' || type === 'create_task_list') {
                        const title = data.title || data.name;
                        log(`[PersonalAssistant] Executing server-side createTaskList: ${title}`);
                        await createTaskList(userId, title);
                        log('[PersonalAssistant] ✅ Task List created');
                    } else if (type === 'completetask' || type === 'complete_task') {
                        const taskId = data.id || data.taskId;
                        const listId = data.listId || '@default';
                        // Note: Finding task by name is harder without syncing all lists, so we rely on ID or context if possible
                        if (taskId) {
                            log(`[PersonalAssistant] Completing task ${taskId}`);
                            await completeTask(userId, taskId, listId);
                            log('[PersonalAssistant] ✅ Task completed');
                        } else {
                            log('[PersonalAssistant] ⚠️ Cannot complete task: No ID provided');
                        }
                    }
                    // === GOOGLE SHEETS ACTIONS ===
                    else if (type === 'createspreadsheet' || type === 'create_spreadsheet') {
                        const title = data.title || data.name || 'Untitled Spreadsheet';
                        log(`[PersonalAssistant] Executing server-side createSpreadsheet: ${title}`);
                        const newSheet = await createSpreadsheet(userId, title);
                        log(`[PersonalAssistant] ✅ Spreadsheet created: ${newSheet.url}`);
                        result.text += language === 'nl'
                            ? `\n\n[Open Spreadsheet](${newSheet.url})`
                            : `\n\n[Open Spreadsheet](${newSheet.url})`;
                    } else if (type === 'appendspreadsheet' || type === 'append_spreadsheet' || type === 'add_row') {
                        // If title is provided (not ID), find or create the spreadsheet first
                        let spreadsheetId = data.spreadsheetId || data.id;
                        const title = data.title || data.name;
                        // Always use Sheet1 for new spreadsheets (sheetName might not exist)
                        const range = data.range || 'Sheet1';
                        const values = data.values || data.rows || [[]];
                        let isNewSpreadsheet = false;

                        // Check cache first
                        if (!spreadsheetId && title && spreadsheetCache[title.toLowerCase()]) {
                            spreadsheetId = spreadsheetCache[title.toLowerCase()];
                            log(`[PersonalAssistant] Using cached spreadsheet ID: ${spreadsheetId}`);
                        }

                        // If no ID but we have a title, find or create the spreadsheet
                        if (!spreadsheetId && title) {
                            log(`[PersonalAssistant] Looking for spreadsheet: "${title}"`);
                            const existingSheets = await listSpreadsheets(userId, 50);
                            const found = existingSheets.find((s: any) =>
                                s.name.toLowerCase() === title.toLowerCase()
                            );

                            if (found) {
                                spreadsheetId = found.id;
                                log(`[PersonalAssistant] Found existing spreadsheet: ${spreadsheetId}`);
                            } else {
                                log(`[PersonalAssistant] Creating new spreadsheet: "${title}"`);
                                const newSheet = await createSpreadsheet(userId, title);
                                spreadsheetId = newSheet.id;
                                isNewSpreadsheet = true;
                                log(`[PersonalAssistant] ✅ Created spreadsheet: ${newSheet.url}`);
                                result.text += language === 'nl'
                                    ? `\n\n[Open Spreadsheet](${newSheet.url})`
                                    : `\n\n[Open Spreadsheet](${newSheet.url})`;
                            }
                            // Cache the ID for subsequent actions
                            spreadsheetCache[title.toLowerCase()] = spreadsheetId;
                        }

                        if (!spreadsheetId) {
                            throw new Error('No spreadsheet ID or title provided');
                        }

                        // For new spreadsheets, always use Sheet1
                        const actualRange = isNewSpreadsheet ? 'Sheet1' : range;
                        log(`[PersonalAssistant] Appending data to spreadsheet ${spreadsheetId} range ${actualRange}`);
                        await appendSpreadsheetData(userId, spreadsheetId, actualRange, values);
                        log('[PersonalAssistant] ✅ Data appended to spreadsheet');
                    } else if (type === 'updatespreadsheet' || type === 'update_spreadsheet') {
                        const spreadsheetId = data.spreadsheetId || data.id;
                        const range = data.range || 'Sheet1!A1';
                        const values = data.values || [[]];
                        log(`[PersonalAssistant] Executing server-side updateSpreadsheetData`);
                        await updateSpreadsheetData(userId, spreadsheetId, range, values);
                        log('[PersonalAssistant] ✅ Spreadsheet updated');
                    }
                    // === CHART CREATION ===
                    else if (type === 'createchart' || type === 'create_chart') {
                        const title = data.title || data.spreadsheetTitle;
                        const chartType = data.chartType || 'bar';
                        const chartTitle = data.chartTitle || 'Chart';
                        const dataRange = data.dataRange || { startRow: 1, endRow: 10, startCol: 0, endCol: 2 };

                        // Find spreadsheet by title
                        // Check cache first, then API
                        let spreadsheetId = data.spreadsheetId;
                        if (!spreadsheetId && title && spreadsheetCache[title.toLowerCase()]) {
                            spreadsheetId = spreadsheetCache[title.toLowerCase()];
                            log(`[PersonalAssistant] Using cached spreadsheet ID for chart: ${spreadsheetId}`);
                        }
                        if (!spreadsheetId && title) {
                            const sheets = await listSpreadsheets(userId, 50);
                            const found = sheets.find((s: any) => s.name.toLowerCase() === title.toLowerCase());
                            if (found) spreadsheetId = found.id;
                        }

                        if (!spreadsheetId) {
                            throw new Error('Spreadsheet not found for chart');
                        }

                        log(`[PersonalAssistant] Creating ${chartType} chart: "${chartTitle}"`);
                        await createChart(userId, spreadsheetId, 0, chartType, chartTitle, dataRange);
                        log('[PersonalAssistant] ✅ Chart created');
                    }
                    // === FORMAT CELLS ===
                    else if (type === 'formatcells' || type === 'format_cells') {
                        const title = data.title || data.spreadsheetTitle;
                        const range = data.range || { startRow: 0, endRow: 1, startCol: 0, endCol: 10 };
                        const format = data.format || { bold: true };

                        // Check cache first, then API
                        let spreadsheetId = data.spreadsheetId;
                        if (!spreadsheetId && title && spreadsheetCache[title.toLowerCase()]) {
                            spreadsheetId = spreadsheetCache[title.toLowerCase()];
                            log(`[PersonalAssistant] Using cached spreadsheet ID for formatting: ${spreadsheetId}`);
                        }
                        if (!spreadsheetId && title) {
                            const sheets = await listSpreadsheets(userId, 50);
                            const found = sheets.find((s: any) => s.name.toLowerCase() === title.toLowerCase());
                            if (found) spreadsheetId = found.id;
                        }

                        if (!spreadsheetId) throw new Error('Spreadsheet not found for formatting');

                        log(`[PersonalAssistant] Formatting cells in spreadsheet`);
                        await formatCells(userId, spreadsheetId, 0, range, format);
                        log('[PersonalAssistant] ✅ Cells formatted');
                    }
                    // === ADD BORDERS ===
                    else if (type === 'addborders' || type === 'add_borders') {
                        const title = data.title || data.spreadsheetTitle;
                        const range = data.range || { startRow: 0, endRow: 10, startCol: 0, endCol: 10 };
                        const style = data.style || 'SOLID';

                        // Check cache first, then API
                        let spreadsheetId = data.spreadsheetId;
                        if (!spreadsheetId && title && spreadsheetCache[title.toLowerCase()]) {
                            spreadsheetId = spreadsheetCache[title.toLowerCase()];
                            log(`[PersonalAssistant] Using cached spreadsheet ID for borders: ${spreadsheetId}`);
                        }
                        if (!spreadsheetId && title) {
                            const sheets = await listSpreadsheets(userId, 50);
                            const found = sheets.find((s: any) => s.name.toLowerCase() === title.toLowerCase());
                            if (found) spreadsheetId = found.id;
                        }

                        if (!spreadsheetId) throw new Error('Spreadsheet not found for borders');

                        log(`[PersonalAssistant] Adding borders to spreadsheet`);
                        await addBorders(userId, spreadsheetId, 0, range, style);
                        log('[PersonalAssistant] ✅ Borders added');
                    }
                    // === FREEZE ROWS/COLS ===
                    else if (type === 'freezerows' || type === 'freeze_rows' || type === 'freezecolumns' || type === 'freeze_columns') {
                        const title = data.title || data.spreadsheetTitle;
                        const frozenRows = data.frozenRows || data.rows;
                        const frozenCols = data.frozenCols || data.cols || data.columns;

                        // Check cache first, then API
                        let spreadsheetId = data.spreadsheetId;
                        if (!spreadsheetId && title && spreadsheetCache[title.toLowerCase()]) {
                            spreadsheetId = spreadsheetCache[title.toLowerCase()];
                            log(`[PersonalAssistant] Using cached spreadsheet ID for freeze: ${spreadsheetId}`);
                        }
                        if (!spreadsheetId && title) {
                            const sheets = await listSpreadsheets(userId, 50);
                            const found = sheets.find((s: any) => s.name.toLowerCase() === title.toLowerCase());
                            if (found) spreadsheetId = found.id;
                        }

                        if (!spreadsheetId) throw new Error('Spreadsheet not found for freeze');

                        log(`[PersonalAssistant] Freezing rows/columns`);
                        await freezeRowsOrColumns(userId, spreadsheetId, 0, frozenRows, frozenCols);
                        log('[PersonalAssistant] ✅ Rows/columns frozen');
                    }

                    // === GOOGLE TASKS ACTIONS ===
                    else if (type === 'createtask' || type === 'create_task' || type === 'createnote' || type === 'create_note') {
                        const title = data.title || 'Untitled Task';
                        const notes = data.notes || data.content || data.text || '';
                        const dueDate = data.due || data.dueDate;

                        // Parse list parameter (prompt uses "list", but code used taskListId)
                        let taskListId = data.taskListId || data.listId || data.list_id || data.list;

                        // Smart Resolution: If taskListId looks like a name (not an ID) or is missing, try to resolve it
                        if (taskListId && taskListId !== '@default' && !taskListId.match(/^[a-zA-Z0-9_-]{10,}$/)) {
                            // Assume it's a name like "Shopping List"
                            const listName = taskListId;
                            log(`[PersonalAssistant] Resolving Task List by name: "${listName}"`);

                            try {
                                const currentLists = await getTaskLists(userId);
                                const foundList = currentLists.find((l: any) => l.title.toLowerCase() === listName.toLowerCase());

                                if (foundList) {
                                    taskListId = foundList.id;
                                    log(`[PersonalAssistant] Found existing list "${listName}" -> ID: ${taskListId}`);
                                } else {
                                    log(`[PersonalAssistant] List "${listName}" not found. Creating it...`);
                                    const newList = await createTaskList(userId, listName);
                                    taskListId = newList.id;
                                    log(`[PersonalAssistant] Created new list "${listName}" -> ID: ${taskListId}`);
                                }
                            } catch (err: any) {
                                log(`[PersonalAssistant] ⚠️ Failed to resolve list name "${listName}": ${err.message}. Falling back to default.`);
                                taskListId = '@default';
                            }
                        }

                        // Fallback to default if still null
                        if (!taskListId) taskListId = '@default';

                        log(`[PersonalAssistant] Executing server-side createTask: "${title}" in list ID ${taskListId}`);
                        await createTask(userId, title, notes, dueDate, taskListId);
                        log('[PersonalAssistant] ✅ Task created');
                    } else if (type === 'completetask' || type === 'complete_task') {
                        const taskId = data.taskId || data.id;
                        log(`[PersonalAssistant] Executing server-side completeTask: ${taskId}`);
                        await completeTask(userId, taskId);
                        log('[PersonalAssistant] ✅ Task completed');
                    } else if (type === 'deletetask' || type === 'delete_task' || type === 'deletenote' || type === 'delete_note') {
                        const taskId = data.taskId || data.noteId || data.id;
                        log(`[PersonalAssistant] Executing server-side deleteTask: ${taskId}`);
                        await deleteTask(userId, taskId);
                        log('[PersonalAssistant] ✅ Task deleted');
                    } else if (type === 'createtasklist' || type === 'create_task_list' || type === 'create_list') {
                        const title = data.title || data.name || 'New List';
                        log(`[PersonalAssistant] Executing server-side createTaskList: ${title}`);
                        await createTaskList(userId, title);
                        log('[PersonalAssistant] ✅ Task list created');
                    }
                    // === GOOGLE DOCS ACTIONS ===
                    else if (type === 'createdocument' || type === 'create_document' || type === 'create_doc') {
                        const title = data.title || data.name || 'Untitled Document';
                        let content = data.content || data.text || data.notes || data.initialContent || data.body || data.description || '';

                        // Ensure content is a string
                        if (typeof content !== 'string') {
                            content = JSON.stringify(content);
                        }

                        // Debug: If content is empty, force a placeholder to prove API works
                        if (!content.trim()) {
                            log('[PersonalAssistant] ⚠️ No content provided by LLM. Using placeholder.');
                            content = "(Draft created. No content provided by Assistant.)";
                        }

                        log(`[PersonalAssistant] Executing server-side createDocument: ${title} (Content: ${content.length} chars)`);
                        const newDoc = await createDocument(userId, title, content);
                        log(`[PersonalAssistant] ✅ Document created: ${newDoc.url}`);
                        result.text += language === 'nl'
                            ? `\n\n[Open Document](${newDoc.url})`
                            : `\n\n[Open Document](${newDoc.url})`;
                    } else if (type === 'appendtodocument' || type === 'append_to_document' || type === 'add_to_doc') {
                        const documentId = data.documentId || data.id;
                        const text = data.text || data.content || '';
                        log(`[PersonalAssistant] Executing server-side appendToDocument`);
                        await appendToDocument(userId, documentId, text);
                        log('[PersonalAssistant] ✅ Text appended to document');
                    } else {
                        // These are CLIENT-SIDE only actions - log them without warning
                        const clientSideActions = [
                            'open_whatsapp', 'openwhatsapp',
                            'open_sms', 'opensms',
                            'open_line', 'openline',
                            'open_url', 'openurl',
                            'open_navigation', 'opennavigation',
                            'request_gps', 'requestgps',
                            'media_player.play_media', 'play_media'
                        ];
                        if (clientSideActions.includes(type)) {
                            log(`[PersonalAssistant] 📱 Client-side action queued: "${type}"`);
                        } else {
                            log(`[PersonalAssistant] ⚠️ Unhandled Action Type: "${type}". Data: ${JSON.stringify(data)}`);
                        }
                    }
                } catch (err: any) {
                    log(`[PersonalAssistant] ❌ Service execution failed: ${err.message}`);
                    result.text += language === 'nl' ? `\n(Let op: Uitvoeren mislukt: ${err.message})` : `\n(Note: Execution failed: ${err.message})`;
                }
            }
        }

        // Filter out server-side actions so client doesn't try to execute them
        const serverSideTypes = [
            'createdocument', 'create_document', 'create_doc',
            'appendtodocument', 'append_to_document', 'add_to_doc',
            'createspreadsheet', 'create_spreadsheet',
            'appendspreadsheet', 'append_spreadsheet', 'add_row',
            'updatespreadsheet', 'update_spreadsheet',
            'createchart', 'create_chart',
            'formatcells', 'format_cells',
            'addborders', 'add_borders',
            'freezerows', 'freeze_rows', 'freezecolumns', 'freeze_columns',
            'createtask', 'create_task', 'createnote', 'create_note',
            'completetask', 'complete_task',
            'deletetask', 'delete_task', 'deletenote', 'delete_note',
            'createtasklist', 'create_task_list', 'create_list'
        ];

        // request_gps IS a client-side action (Butler Client handles it). Do NOT filter it.
        // But Docs/Sheets/Tasks are server-side.

        result.actions = result.actions.filter((a: any) => {
            const type = (a.action || a.type || a.service || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
            return !serverSideTypes.includes(type) && !serverSideTypes.includes(a.action?.toLowerCase());
        });

        return result as PersonalAssistantResult;
    }

    return {
        text: response || (language === 'nl' ? 'Ik kon dat niet verwerken.' : 'I couldn\'t process that request.'),
        actions: []
    };
}
