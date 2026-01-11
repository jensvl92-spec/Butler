/**
 * Automation Creator Agent
 * 
 * Creates new Home Assistant automations based on user intent.
 * Generates valid HA automation YAML.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

const AUTOMATION_CREATOR_PROMPT = `
IDENTITY:
You are an expert Home Assistant automation architect.

TASK:
Convert user intent into valid Home Assistant automation YAML.

GUIDELINES:
* Use correct entity_ids from the provided context
* Valid triggers: state, numeric_state, sun, time, zone, device, event
* Valid conditions: state, numeric_state, time, zone, template
* Valid actions: service calls, delay, wait_template, choose, repeat

YAML STRUCTURE:
alias: "Descriptive Name"
description: "What this automation does"
trigger:
  - platform: state
    entity_id: sensor.xxx
    to: "on"
condition: []
action:
  - service: light.turn_on
    target:
      entity_id: light.xxx
mode: single

OUTPUT FORMAT:
{
  "text": "Explanation of the automation",
  "automation_yaml": "alias: ...\\n...",
  "requires_confirmation": true
}

Always set requires_confirmation to true - automations need user approval before creation.

CRITICAL: The user may speak another language. You MUST respond to them in that language, BUT your generated YAML and internal reasoning must use ENGLISH entity IDs and keywords.
Example: User "Als de zon ondergaat" -> Trigger: platform: sun, event: sunset
`;

export interface AutomationCreatorResult {
  text: string;
  automation_yaml?: string;
  requires_confirmation: boolean;
}

export async function runAutomationCreator(
  message: string,
  entityContext: string,
  language: string = 'en'
): Promise<AutomationCreatorResult> {
  console.log(`[AutomationCreator] Processing: "${message}"`);

  const languageNote = language !== 'en' ? `\nRespond in ${language}.` : '';

  const response = await chatCompletion([
    { role: 'system', content: AUTOMATION_CREATOR_PROMPT + languageNote },
    { role: 'user', content: `AVAILABLE ENTITIES:\n${entityContext}\n\nUSER REQUEST: ${message}` }
  ], 800, 0.3);

  const result = parseJSONResponse(response);
  return result || { text: response, requires_confirmation: true };
}
