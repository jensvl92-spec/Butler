/**
 * Personal Assistant Agent
 * 
 * Handles personal life management: Calendar, Email, Weather, Music, Navigation, Tasks.
 * Delegates from Butler when request is about personal matters rather than device control.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

const PERSONAL_ASSISTANT_PROMPT = `
IDENTITY:
You are a highly organized executive personal assistant. You help with daily life management.

CAPABILITIES:
1. **Calendar** - Check upcoming events, create meetings, find free time
2. **Email** - Summarize unread emails, send emails, search inbox  
3. **Weather** - Current conditions, forecasts, rain predictions
4. **Music** - Play songs, control playback, get playlists (Spotify)
5. **Navigation** - Get directions, ETAs, traffic conditions
6. **Tasks** - View to-do lists, add tasks, manage shopping lists

GUIDELINES:
* Be accurate with times and dates
* Summarize emails unless asked for full text (privacy)
* Be proactive - if user has meeting soon, mention traffic
* For music, assume Spotify unless specified otherwise

CURRENT LIMITATIONS (be honest about these):
* Calendar integration may not be fully connected yet
* Some features are being developed

OUTPUT FORMAT:
{
  "text": "Helpful response to the user",
  "actions": [],
  "data": {
    "events": [...] | "weather": {...} | "emails": [...] | null
  }
}
`;

export interface PersonalAssistantResult {
    text: string;
    actions: Array<any>;
    data?: Record<string, any>;
}

/**
 * Run the Personal Assistant agent.
 * 
 * @param message - User's request  
 * @param context - Available context (devices, time, etc.)
 * @param mcpProxyUrl - URL of the MCP proxy (for memory lookup)
 * @param language - User's preferred language
 * @returns PersonalAssistantResult
 */
export async function runPersonalAssistant(
    message: string,
    context: string,
    mcpProxyUrl: string,
    language: string = 'en'
): Promise<PersonalAssistantResult> {
    console.log(`[PersonalAssistant] Processing: "${message}"`);

    const currentTime = new Date().toISOString();
    const languageNote = language !== 'en'
        ? `\n\nIMPORTANT: Respond in ${language}.`
        : '';

    const response = await chatCompletion([
        { role: 'system', content: PERSONAL_ASSISTANT_PROMPT + languageNote },
        { role: 'user', content: `CURRENT TIME: ${currentTime}\nCONTEXT: ${context}\n\nREQUEST: ${message}` }
    ], 500, 0.5);

    const result = parseJSONResponse(response);

    if (result) {
        console.log(`[PersonalAssistant] Result:`, result);
        return result as PersonalAssistantResult;
    }

    // Fallback - just return the text
    return {
        text: response || (language === 'nl' ? 'Ik kon dat niet verwerken.' : 'I couldn\'t process that request.'),
        actions: []
    };
}
