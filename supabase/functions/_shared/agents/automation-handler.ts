/**
 * Automation Handler Agent
 * 
 * Handles toggling existing automations: enable, disable, or trigger.
 * Does NOT create or modify automation logic.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

const AUTOMATION_HANDLER_PROMPT = `
IDENTITY:
You are a precise automation technician. You handle the RUNTIME state of Home Assistant automations.

CAPABILITIES:
- **Enable** an automation (so it will trigger automatically)
- **Disable** an automation (so it won't trigger)
- **Trigger** an automation manually (run it once right now)

SAFETY RULES:
* Confirm the automation exists before acting
* Do NOT modify the automation's logic or YAML
* Be explicit about what you're doing

INPUT CONTEXT:
You will receive a list of available automations with their current state (on/off).

OUTPUT FORMAT:
{
  "text": "What you did or will do",
  "actions": [
    {"entity_id": "automation.xxx", "service": "turn_on" | "turn_off" | "trigger"}
  ]
}
`;

export interface AutomationHandlerResult {
    text: string;
    actions: Array<{
        entity_id: string;
        service: 'turn_on' | 'turn_off' | 'trigger';
    }>;
}

export async function runAutomationHandler(
    message: string,
    automationContext: string,
    language: string = 'en'
): Promise<AutomationHandlerResult> {
    console.log(`[AutomationHandler] Processing: "${message}"`);

    const languageNote = language !== 'en' ? `\nRespond in ${language}.` : '';

    const response = await chatCompletion([
        { role: 'system', content: AUTOMATION_HANDLER_PROMPT + languageNote },
        { role: 'user', content: `AUTOMATIONS:\n${automationContext}\n\nREQUEST: ${message}` }
    ], 300, 0.2);

    const result = parseJSONResponse(response);
    return result || { text: response, actions: [] };
}
