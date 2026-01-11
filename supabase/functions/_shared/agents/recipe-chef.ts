/**
 * Recipe Chef Agent - Step-by-Step Cooking Assistant
 * 
 * A focused agent for guiding users through recipes one step at a time.
 * Uses Llama 3.3 70B for reliable instruction following.
 */

import { groqMainCompletion, parseJSONResponse } from '../llm-service.ts';

const RECIPE_CHEF_PROMPT = `
IDENTITY: You are a friendly cooking assistant guiding someone through a recipe step-by-step.
You ONLY help with cooking. For anything else, politely decline.

COMMANDS YOU UNDERSTAND (in any language):
- "next" / "volgende" / "verder" → advance to next step
- "repeat" / "herhaal" / "say again" / "nog een keer" / "wat zei je?" → repeat current step
- "how long?" / "hoe lang?" / "timing" → tell timing for current step
- "what's in this?" / "ingrediënten" / "ingredients" → list ingredients for current step
- "I'm done" / "klaar" / "exit" / "stop" / "bedankt" → end cooking session

BEHAVIOR RULES:
1. Give ONE instruction at a time - short and clear
2. Wait for user to say "next" before proceeding
3. Always set "conversation_mode": true (keeps mic listening)
4. When user says they're done or thanks you, set "conversation_mode": false
5. Suggest timers when relevant ("Should I set a 10 minute timer?")
6. Be encouraging! ("Perfect!", "Great job!", "Almost there!")

OUTPUT FORMAT (strict JSON):
\`\`\`json
{
  "text": "Short instruction for current step",
  "current_step": 1,
  "total_steps": 8,
  "conversation_mode": true,
  "actions": []
}
\`\`\`

TIMER ACTION (when user confirms):
{ "service": "recipe.timer", "data": { "minutes": 10, "label": "pasta" } }

EXIT ACTION (when user is done):
Set "conversation_mode": false

EXAMPLE CONVERSATION:
User: "Start cooking carbonara"
→ {"text": "Let's make carbonara! Step 1 of 6: Bring a large pot of salted water to boil. Let me know when it's boiling!", "current_step": 1, "total_steps": 6, "conversation_mode": true, "actions": []}

User: "next"
→ {"text": "Step 2: While waiting, dice 150 grams of guanciale or pancetta into small cubes. Ready?", "current_step": 2, "total_steps": 6, "conversation_mode": true, "actions": []}

User: "say again"
→ {"text": "Sure! Dice 150 grams of guanciale or pancetta into small cubes.", "current_step": 2, "total_steps": 6, "conversation_mode": true, "actions": []}

User: "I'm done, thanks!"
→ {"text": "Enjoy your carbonara! Buon appetito! 🍝", "current_step": 6, "total_steps": 6, "conversation_mode": false, "actions": []}
`;

export interface RecipeChefResult {
    text: string;
    current_step?: number;
    total_steps?: number;
    conversation_mode: boolean;
    actions: Array<{ service: string; data?: Record<string, any> }>;
}

/**
 * Run the Recipe Chef agent for step-by-step cooking guidance.
 * 
 * @param userMessage - Current user message
 * @param recipeContext - The recipe being cooked (ingredients, steps)
 * @param chatHistory - Recent conversation for context
 * @param language - User's language preference
 * @param log - Logging function
 */
export async function runRecipeChef(
    userMessage: string,
    recipeContext: string,
    chatHistory: string,
    language: string = 'en',
    log: (msg: string) => void
): Promise<RecipeChefResult> {
    log('[RecipeChef] Processing: "' + userMessage + '"');

    const languageNote = language !== 'en'
        ? `\n\nIMPORTANT: Respond in ${language}. Understand commands in any language.`
        : '';

    const contextBlock = recipeContext
        ? `\n\nCURRENT RECIPE:\n${recipeContext}`
        : '';

    const historyBlock = chatHistory
        ? `\n\nRECENT CONVERSATION:\n${chatHistory}`
        : '';

    const fullPrompt = RECIPE_CHEF_PROMPT + languageNote + contextBlock + historyBlock;

    const response = await groqMainCompletion([
        { role: 'system', content: fullPrompt },
        { role: 'user', content: userMessage }
    ], 400, 0.3);

    const result = parseJSONResponse(response);

    if (result) {
        log(`[RecipeChef] Step ${result.current_step || '?'}/${result.total_steps || '?'}, conversation_mode=${result.conversation_mode}`);
        return {
            text: result.text || response,
            current_step: result.current_step,
            total_steps: result.total_steps,
            conversation_mode: result.conversation_mode !== false, // Default to true
            actions: result.actions || []
        };
    }

    // Fallback
    return {
        text: response,
        conversation_mode: true,
        actions: []
    };
}
