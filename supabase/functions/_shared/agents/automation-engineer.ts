/**
 * Automation Engineer Agent
 * Takes behavior patterns and proposes concrete, executable Home Assistant automations.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

const ENGINEER_SYSTEM_PROMPT = `
IDENTITY:
You are an expert Home Assistant Automation Engineer.

TASK:
Propose useful, executable Home Assistant automations based on the provided behavior patterns.

RULES:
1. High Value Only: Only propose if the data strongly supports it (confidence >= 0.7).
2. Avoid Nagging: Do NOT propose anything similar to the "Denied Proposals".
3. Quantity: Up to 5 high-value proposals.
4. Executable HA YAML/JSON: Every proposal MUST include a valid \`ha_automation\` object with real \`entity_id\`s from the analysis patterns.

OUTPUT FORMAT (valid JSON ONLY):
{
  "text": "Polite summary explaining the proposed automations.",
  "proposals": [
    {
      "title": "Short descriptive title",
      "trigger": "Human readable trigger description",
      "condition": "Human readable condition (or 'Geen')",
      "action": "Human readable action description",
      "reasoning": "Why this automation helps based on observed behavior",
      "ha_automation": {
        "alias": "Short descriptive title",
        "description": "Why this automation helps",
        "trigger": [{ "platform": "state", "entity_id": "binary_sensor.example", "to": "on" }],
        "condition": [],
        "action": [{ "service": "light.turn_on", "target": { "entity_id": "light.example" } }],
        "mode": "single"
      }
    }
  ]
}
`;

export interface Proposal {
  title: string;
  trigger: string;
  condition: string;
  action: string;
  reasoning: string;
  ha_automation?: Record<string, any>;
}

export interface EngineerResult {
  text: string;
  proposals: Proposal[];
}

export async function runAutomationEngineer(
  analysis: any,
  deniedProposals: string[] = [],
  language: string = 'nl'
): Promise<EngineerResult> {
  console.log(`[Engineer] Generating proposals based on analysis...`);

  const langInstruction = `\nWrite title, trigger, condition, action, reasoning, and text in ${language.startsWith('nl') ? 'Dutch' : language}, but keep ha_automation keys and entity_ids in standard English Home Assistant format.`;

  const userInput = `
ANALYSIS PATTERNS:
${JSON.stringify(analysis, null, 2)}

DENIED PROPOSALS (DO NOT REPEAT):
${deniedProposals.join('\n') || 'None'}
`;

  const response = await chatCompletion(
    [
      { role: 'system', content: ENGINEER_SYSTEM_PROMPT + langInstruction },
      { role: 'user', content: userInput }
    ],
    6000,
    0.4,
    undefined,
    undefined,
    undefined,
    { effort: 'medium' },
    'high_accuracy'
  );

  const result = parseJSONResponse(typeof response === 'string' ? response : JSON.stringify(response));
  return result || { text: "Geen geschikte automatiseringen gevonden op dit moment.", proposals: [] };
}
