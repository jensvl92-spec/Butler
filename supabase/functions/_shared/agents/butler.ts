/**
 * Butler Agent - Direct Context Architecture
 * 
 * Butler receives pre-loaded context from the Router:
 * - Devices with their current states
 * - Relevant memories about user preferences
 * - Chat history for context (pronouns, corrections, undo)
 * 
 * This is optimized for speed with a single LLM call.
 */

import { groqMainCompletion, parseJSONResponse } from '../llm-service.ts';

// ============================================================================
// TYPES
// ============================================================================

export interface ButlerAction {
    entity_id: string;
    service: string;
    data?: Record<string, any>;
}

export interface ButlerResult {
    text: string;
    actions: ButlerAction[];
    scheduled_actions?: any[];
    delegate_to?: string | null;
}

interface RouterContext {
    tools: any[];
    devices: { entity_id: string; state: string }[];
    memories: string[];
    reasoning: string;
    agents?: string[];
}

// ============================================================================
// BUTLER PROMPT
// ============================================================================

const BUTLER_PROMPT = `
IDENTITY: Home Assistant Agent with PRE-LOADED device context.
GOAL: Analyze the devices and their states, then generate actions.

YOU HAVE BEEN GIVEN:
- A list of relevant DEVICES with their current STATE
- Recent CHAT HISTORY for context (pronouns, corrections, undo)
- Optional MEMORIES about user preferences

PROCEDURE:
1. CHECK STATES: Review each device's current state
2. FILTER: Skip devices already in the desired state
3. DECIDE: Generate JSON actions for devices that need to change

CRITICAL RULES:
1. If a device is ALREADY in the target state, SKIP IT and mention it
2. For plural requests ("lights"), act on ALL matching devices
3. For pronouns ("them", "ze"), refer to chat history
4. ENERGY: Use \`energy.optimize_schedule\` with \`target_percent\`, \`battery_entity_id\`, or \`prefer_solar\` for advanced logic.
5. PREHEAT: use \`energy.preheat_check\` if user asks to heat efficiently.
6. GRAPH: Use \`graph.create\` service to visualize data. Include title, period (1d/3d/7d/10d), and series array.
7. DELAYED: For "in X minutes" commands, use scheduled_actions with wait_ms.
8. Output ONLY valid JSON

PHONE FEATURES (Native to User's Smartphone - NO DEVICES NEEDED):
These features control the user's PHONE directly. They ALWAYS work even if there are 0 Home Assistant devices.
ALWAYS generate the action - do NOT ask questions or check for devices.

- "Set timer for 5 minutes" → { "service": "recipe.timer", "data": { "minutes": 5, "label": "Timer" } }
- "Alarm over 1 uur" / "Wake me in 1 hour" → Calculate: current time + 1 hour → { "service": "alarm.set", "data": { "hour": <calculated>, "minute": <calculated>, "message": "Alarm" } }
- "Set an alarm for 7:30" → { "service": "alarm.set", "data": { "hour": 7, "minute": 30, "message": "Wake up" } }

DELAYED ACTIONS ("in X minutes") - Use scheduled_actions:
- "Turn off lights in 10 minutes" → { "title": "Turn off lights", "wait_ms": 600000, "actions": [...] }
- DO NOT use inline delays. Use scheduled_actions ONLY.
- SEQUENCED DELAYS: For commands like "do A in 5 min, then do B 10 min later", calculate CUMULATIVE wait_ms from NOW.
    Example: "Turn on in 1 min, then off 2 min later" (total 3 min for off):
    - scheduled_actions: [
        { "title": "Turn on", "wait_ms": 60000, "actions": [turn on] },
        { "title": "Turn off", "wait_ms": 180000, "actions": [turn off] }  // 1 min + 2 min = 3 min total
      ]

EMERGENCY MODE:
- If user says "help", "emergency", "I've fallen", "break in", "fire", etc. → ALWAYS ASK FOR CONFIRMATION FIRST
- Say: "I heard you might need help. Are you in an emergency? Say 'yes' to confirm."
- Only AFTER user confirms, use emergency.* services

OUTPUT FORMAT (strict JSON):
\`\`\`json
{
  "text": "Response to user (in their language)",
  "actions": [ 
    { "entity_id": "x", "service": "domain.turn_on", "data": {} }
  ],
  "scheduled_actions": [
    { "title": "Task description", "wait_ms": 600000, "actions": [{...}] }
  ],
  "conversation_mode": true/false
}
\`\`\`

EXAMPLES:

User: "Turn on kitchen lights"
Devices: light.kitchen_1 (on), switch.kitchen_spots (off)
Response: {"text": "Kitchen light is already on. Turning on spots.", "actions": [{"entity_id": "switch.kitchen_spots", "service": "switch.turn_on"}]}

User: "Turn off living room lights in 5 minutes"  
Response: {"text": "I'll turn off the lights in 5 minutes.", "actions": [], "scheduled_actions": [{"title": "Turn off living room", "wait_ms": 300000, "actions": [{"entity_id": "light.living_room", "service": "light.turn_off"}]}]}
`;

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Run Butler with pre-loaded context from Router (NO tool calling!)
 * This is faster because it eliminates the query_mcp tool call round trip.
 */
export async function runButlerWithContext(
    user_message: string,
    routerContext: RouterContext,
    chatHistory: string,
    log: (msg: string) => void,
    language: string = 'en'
): Promise<ButlerResult> {
    log(`[Butler] Processing with pre-loaded context: ${routerContext.devices?.length || 0} devices`);

    // Check for agent delegation from Router
    if (routerContext.agents && routerContext.agents.length > 0) {
        const agent = routerContext.agents[0];
        log(`[Butler] Router recommends delegation to: ${agent}`);
        return {
            text: '',
            actions: [],
            delegate_to: agent.toLowerCase().replace(' ', '_')
        };
    }

    // Format device context
    const deviceContext = (routerContext.devices || [])
        .map(d => `- ${d.entity_id}: ${d.state}`)
        .join('\n');

    const memoriesContext = (routerContext.memories || []).length > 0
        ? `\nUSER MEMORIES:\n${routerContext.memories.join('\n')}`
        : '';

    const historyContext = chatHistory
        ? `\nRECENT CHAT HISTORY:\n${chatHistory}`
        : '';

    const languageNote = language !== 'en'
        ? `\n\nIMPORTANT: Respond in ${language}.`
        : '';

    // Reminder for phone features (works without HA devices)
    const phoneFeatureReminder = `
NOTE: PHONE FEATURES (timer, alarm) are NATIVE to the user's smartphone and ALWAYS WORK regardless of Home Assistant devices.
If user asks to set a timer or alarm, ALWAYS return the action immediately. Do NOT say "no devices available".`;

    const userPrompt = `AVAILABLE DEVICES (with current state):
${deviceContext || 'No Home Assistant devices matched this request.'}
${phoneFeatureReminder}
${memoriesContext}
${historyContext}

USER REQUEST: ${user_message}`;

    // Single LLM call - no tool loop needed!
    const response = await groqMainCompletion([
        { role: 'system', content: BUTLER_PROMPT + languageNote },
        { role: 'user', content: userPrompt }
    ], 600, 0.2);

    const result = parseJSONResponse(response);

    if (result) {
        log(`[Butler] Done. Actions: ${result.actions?.length || 0}, Scheduled: ${result.scheduled_actions?.length || 0}`);
        return {
            text: result.text || response,
            actions: result.actions || [],
            scheduled_actions: result.scheduled_actions || [],
            delegate_to: result.delegate_to
        };
    }

    // Fallback
    return { text: response, actions: [] };
}

// Legacy export for backwards compatibility (redirects to new function)
export async function runButler(
    user_message: string,
    mcpProxyUrl: string,
    connectionId: string,
    log: (msg: string) => void,
    language: string = 'en',
    deviceStates: Record<string, string> = {}
): Promise<ButlerResult> {
    log('[Butler] Legacy runButler called - use runButlerWithContext instead');
    // Minimal fallback - should not be used in production
    return { text: 'Please update to use runButlerWithContext', actions: [] };
}
