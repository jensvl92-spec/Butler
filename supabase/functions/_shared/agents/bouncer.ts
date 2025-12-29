/**
 * Bouncer Agent - Intent Validator
 * 
 * First line of defense: validates if user request is within Butler's capabilities.
 * Rejects off-topic requests politely, accepts valid home automation and personal assistant requests.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

const BOUNCER_SYSTEM_PROMPT = `
IDENTITY:
You are the friendly but firm gatekeeper. Your ONLY job is to filter requests.

CAPABILITIES (ACCEPT these):
1. **Home Assistant**: Control devices, automations, scenes (e.g., "turn on lights", "set thermostat to 22")
2. **Personal**: Calendar, Email, Tasks (e.g., "what's my next meeting?", "check emails")
3. **Info**: Navigation (ETA), Weather, Music (Spotify) (e.g., "how long to work?", "will it rain?")

RULES:
* **REJECT** off-topic requests (recipes, coding help, jokes, general knowledge) - politely explain limitations
* **ACCEPT** vague but relevant requests (e.g., "it's dark" → might want lights, "it's cold" → heating)
* **Output JSON ONLY** - no extra text

OUTPUT FORMAT (strict JSON):
{
  "is_valid": boolean,
  "intent_type": "home_assistant" | "calendar" | "email" | "navigation" | "weather" | "music" | "tasks" | "other",
  "reasoning": "brief explanation",
  "rejection_message": "polite rejection text (only if is_valid=false)"
}

EXAMPLES:
User: "Cook me dinner" → {"is_valid": false, "intent_type": "other", "reasoning": "Cooking is physical, not smart home", "rejection_message": "I can't cook, but I can preheat your oven or control kitchen appliances!"}
User: "It's too hot" → {"is_valid": true, "intent_type": "home_assistant", "reasoning": "User likely wants AC or fan"}
User: "Turn on the lights" → {"is_valid": true, "intent_type": "home_assistant", "reasoning": "Direct device control request"}
User: "What's 2+2?" → {"is_valid": false, "intent_type": "other", "reasoning": "General math question", "rejection_message": "I'm your home assistant, not a calculator. Try asking about your home or schedule!"}
`;

export interface BouncerResult {
    is_valid: boolean;
    intent_type: 'home_assistant' | 'calendar' | 'email' | 'navigation' | 'weather' | 'music' | 'tasks' | 'other';
    reasoning: string;
    rejection_message?: string;
}

/**
 * Run the Bouncer agent to validate user intent.
 * 
 * @param message - User's raw message
 * @param language - User's preferred language (for rejection messages)
 * @returns BouncerResult with validation status
 */
export async function runBouncer(message: string, language: string = 'en'): Promise<BouncerResult> {
    console.log(`[Bouncer] Validating: "${message}"`);

    const languageInstruction = language !== 'en'
        ? `\n\nIMPORTANT: If rejecting, write the rejection_message in ${language}.`
        : '';

    const response = await chatCompletion([
        { role: 'system', content: BOUNCER_SYSTEM_PROMPT + languageInstruction },
        { role: 'user', content: message }
    ], 200, 0); // Low temperature for consistent classification

    const result = parseJSONResponse(response);

    if (!result) {
        console.error('[Bouncer] Failed to parse response:', response);
        // Fail open - let butler handle ambiguous cases
        return {
            is_valid: true,
            intent_type: 'other',
            reasoning: 'Parse error - allowing through to butler'
        };
    }

    console.log(`[Bouncer] Result: valid=${result.is_valid}, type=${result.intent_type}`);
    return result as BouncerResult;
}
