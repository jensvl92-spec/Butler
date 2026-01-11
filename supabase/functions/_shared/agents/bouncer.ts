/**
 * Bouncer Agent - Intent Validator
 * 
 * First line of defense: validates if user request is within Butler's capabilities.
 * Rejects off-topic requests politely, accepts valid home automation and personal assistant requests.
 */

import { groqMainCompletion, parseJSONResponse } from '../llm-service.ts';

const BOUNCER_SYSTEM_PROMPT = `
IDENTITY:
You are the friendly but firm gatekeeper. Your ONLY job is to filter requests.

CAPABILITIES (ACCEPT these):
1. **Home Assistant**: Control devices, automations, scenes (e.g., "turn on lights", "set thermostat to 22")
2. **Personal**: Calendar, Email, Tasks (e.g., "what's my next meeting?", "check emails")
3. **Info**: Navigation (ETA), Weather, Music (Spotify/YouTube) (e.g., "how long to work?", "will it rain?")
4. **Messaging**: WhatsApp, SMS (e.g., "app mom I'm late", "text John I'm on my way")
5. **Daily Briefing**: Morning summaries (e.g., "good morning", "briefing", "what's on today?")
6. **Expenses**: Spending tracking (e.g., "I spent $20 on lunch", "log expense")
7. **Sheets/Docs**: Spreadsheet and document operations (e.g., "show my spreadsheets", "create a document")
8. **Shopping**: Smart shopping lists (e.g., "add ingredients for pizza", "add milk to shopping list")
9. **Meeting Prep**: Create meeting notes (e.g., "prep for my 2PM meeting", "create notes for Project Review")
10. **Analysis & Suggestions**: Proposals, patterns, ideas (e.g., "Suggest automations", "Find patterns")
11. **Recipe Mode**: Cooking assistance (e.g., "find a recipe for pasta", "how do I make curry?", "next step", "set timer", "continue hands-free")
12. **Graphs**: Visualize data (e.g., "show me a graph of my energy use", "graph the temperature", "make a chart")
13. **Context/Meta**: Follow-ups, Corrections, Undo, Retry (e.g., "undo that", "try again", "not the kitchen")
14. **Create Automation**: Recurring/scheduled automations (e.g., "every day at 8 AM turn on coffee", "when I come home turn on lights", "elke ochtend om 7 uur", "als ik thuiskom")
15. **Manage Automations**: Enable/disable/trigger existing automations (e.g., "disable the morning routine", "list my automations", "turn off the sunset automation")

CRITICAL RULE FOR FOLLOW-UPS:
* If the user says "Try again", "Repeat", "Do it", or "Yes" after a specific request (like Music, Weather, or Recipe), categorize the intent as that specific type rather than just "conversational".
* When a recipe is active, accept ALL natural language requests for "next", "repeat", "done", "can I talk hands-free?", "stay listening" as **recipe** intent.
* If a phrase implies a **correction** or **continuation** of a previous state, ACCEPT IT.
* Only REJECT clearly unrelated topics (math, history, jokes, coding).

RULES:
* **REJECT** off-topic requests (coding help, jokes, general knowledge, complex calculations) - politely explain limitations
* **ACCEPT** vague but relevant requests (e.g., "it's dark" → might want lights, "it's cold" → heating, "I'm done" in a recipe)
* **Output JSON ONLY** - no extra text

OUTPUT FORMAT (strict JSON):
{
  "is_valid": boolean,
  "intent_type": "home_assistant" | "calendar" | "email" | "navigation" | "weather" | "music" | "tasks" | "messaging" | "briefing" | "expenses" | "sheets" | "docs" | "recipe" | "graph" | "analyzer" | "view_suggestions" | "approve_suggestion" | "reject_suggestion" | "automation_create" | "automation_manage" | "conversational" | "other",
  "reasoning": "brief explanation",
  "rejection_message": "polite rejection text (only if is_valid=false)"
}

EXAMPLES:
User: "Cook me dinner" → {"is_valid": true, "intent_type": "recipe", "reasoning": "Recipe/cooking request"}
User: "Show me a graph of my energy" → {"is_valid": true, "intent_type": "graph", "reasoning": "Data visualization request"}
User: "Next step" → {"is_valid": true, "intent_type": "recipe", "reasoning": "Recipe navigation"}
User: "Stay listening for the recipe" → {"is_valid": true, "intent_type": "recipe", "reasoning": "Hands-free mode request"}
User: "It's too hot" → {"is_valid": true, "intent_type": "home_assistant", "reasoning": "AC/Climate request"}
User: "Turn on the lights" → {"is_valid": true, "intent_type": "home_assistant", "reasoning": "Direct device control request"}
User: "Good morning" → {"is_valid": true, "intent_type": "briefing", "reasoning": "Morning greeting triggers daily briefing"}
User: "App mom that I'll be late" → {"is_valid": true, "intent_type": "messaging", "reasoning": "WhatsApp message request"}
User: "I spent $30 on groceries" → {"is_valid": true, "intent_type": "expenses", "reasoning": "Expense logging request"}
User: "Add ingredients for lasagna to shopping list" → {"is_valid": true, "intent_type": "tasks", "reasoning": "Smart shopping list request"}
User: "Prep for my 2PM meeting" → {"is_valid": true, "intent_type": "docs", "reasoning": "Meeting prep document creation"}
User: "Suggest automations" → {"is_valid": true, "intent_type": "analyzer", "reasoning": "Automation suggestions request"}
User: "Find patterns in my devices" → {"is_valid": true, "intent_type": "analyzer", "reasoning": "Pattern analysis request"}
User: "Analyze my home" → {"is_valid": true, "intent_type": "analyzer", "reasoning": "Home analysis request"}
User: "Show my suggestions" → {"is_valid": true, "intent_type": "view_suggestions", "reasoning": "View pending automation suggestions"}
User: "What suggestions do you have?" → {"is_valid": true, "intent_type": "view_suggestions", "reasoning": "View pending suggestions"}
User: "Accept suggestion 1" → {"is_valid": true, "intent_type": "approve_suggestion", "reasoning": "Approve automation suggestion"}
User: "Accept the first one but at 10 PM" → {"is_valid": true, "intent_type": "approve_suggestion", "reasoning": "Approve with modification"}
User: "Create the second automation" → {"is_valid": true, "intent_type": "approve_suggestion", "reasoning": "Approve automation suggestion"}
User: "Reject suggestion 3" → {"is_valid": true, "intent_type": "reject_suggestion", "reasoning": "Reject automation suggestion"}
User: "I don't like number 1" → {"is_valid": true, "intent_type": "reject_suggestion", "reasoning": "Reject automation suggestion"}
User: "Every day at 8 AM turn on the coffee machine" → {"is_valid": true, "intent_type": "automation_create", "reasoning": "Recurring automation request"}
User: "When I come home turn on the lights" → {"is_valid": true, "intent_type": "automation_create", "reasoning": "Trigger-based automation request"}
User: "Elke ochtend om 7 uur de verwarming aanzetten" → {"is_valid": true, "intent_type": "automation_create", "reasoning": "Recurring automation in Dutch"}
User: "Als de zon ondergaat, doe de lampen aan" → {"is_valid": true, "intent_type": "automation_create", "reasoning": "Sunset trigger automation"}
User: "Make a rule for when temperature drops below 18" → {"is_valid": true, "intent_type": "automation_create", "reasoning": "Condition-based automation"}
User: "Disable the morning routine" → {"is_valid": true, "intent_type": "automation_manage", "reasoning": "Disable existing automation"}
User: "List my automations" → {"is_valid": true, "intent_type": "automation_manage", "reasoning": "List existing automations"}
User: "Turn off the sunset automation" → {"is_valid": true, "intent_type": "automation_manage", "reasoning": "Disable automation"}
User: "Enable the nighttime routine" → {"is_valid": true, "intent_type": "automation_manage", "reasoning": "Enable existing automation"}
User: "Trigger the movie mode automation" → {"is_valid": true, "intent_type": "automation_manage", "reasoning": "Manually trigger automation"}
User: "What's 2+2?" → {"is_valid": false, "intent_type": "other", "reasoning": "General math question", "rejection_message": "I'm your home assistant, not a calculator. Try asking about your home or schedule!"}
`;


export interface BouncerResult {
    is_valid: boolean;
    intent_type: 'home_assistant' | 'calendar' | 'email' | 'navigation' | 'weather' | 'music' | 'tasks' | 'messaging' | 'briefing' | 'expenses' | 'sheets' | 'docs' | 'recipe' | 'graph' | 'analyzer' | 'view_suggestions' | 'approve_suggestion' | 'reject_suggestion' | 'automation_create' | 'automation_manage' | 'conversational' | 'other';
    reasoning: string;
    rejection_message?: string;
}

/**
 * Run the Bouncer agent to validate user intent.
 * Uses Groq Llama 3.1 8B for ultra-fast classification (~750 t/s)
 * 
 * @param message - User's raw message
 * @param language - User's preferred language (for rejection messages)
 * @param history - Recent chat history for context
 * @returns BouncerResult with validation status
 */
export async function runBouncer(
    message: string,
    language: string = 'en',
    history: { role: string, content: string }[] = []
): Promise<BouncerResult> {
    console.log(`[Bouncer] Validating: "${message}" with ${history.length} history items`);

    const languageInstruction = language !== 'en'
        ? `\n\nIMPORTANT: If rejecting, write the rejection_message in ${language}.`
        : '';

    // Format history for context
    const historyContext = history.length > 0
        ? `\nRECENT CONTEXT:\n${history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}\n`
        : '';

    // Use Groq 70B for accurate intent classification
    const response = await groqMainCompletion([
        { role: 'system', content: BOUNCER_SYSTEM_PROMPT + languageInstruction },
        { role: 'user', content: historyContext + `\nCURRENT REQUEST: ${message}` }
    ], 200, 0);

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
