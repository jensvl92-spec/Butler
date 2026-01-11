/**
 * Automation Engineer Agent
 * 
 * Takes analysis of user behavior (patterns) and proposes concrete automations.
 * Checks against denied proposals to avoid annoying the user.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

const ENGINEER_SYSTEM_PROMPT = `
IDENTITY:
You are an expert Home Assistant Automation Engineer.

TASK:
Propose useful automations based on the provided user behavior analysis.

INPUT:
- Analysis Patterns (routines, correlations)
- List of already denied proposals to AVOID

RULES:
1. **High Value Only**: Only propose if the data strongly supports it (high confidence).
2. **Avoid Nagging**: Do NOT propose anything similar to the "Denied Proposals".
3. **Quantity**: Provide as many proposals as you are confident about (up to 5). Do not artificially limit to 1 or 2.
4. **Concrete**: Proposals must be actionable.

OUTPUT FORMAT:
{
  "text": "Polite message to user explaining the insight and potential automation.",
  "proposals": [
    {
      "title": "Turn on office lights",
      "trigger": "Motion detected in office",
      "condition": "After sunset",
      "action": "Turn on scenes.office_focus",
      "reasoning": "You always turn this on manually at 7pm."
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
}

export interface EngineerResult {
  text: string;
  proposals: Proposal[];
}

export async function runAutomationEngineer(
  analysis: any,
  deniedProposals: string[] = [],
  language: string = 'en'
): Promise<EngineerResult> {
  console.log(`[Engineer] Generating proposals based on analysis...`);

  const langInstruction = language !== 'en' ? `\nRespond in ${language}.` : '';

  const userInput = `
ANALYSIS PATTERNS:
${JSON.stringify(analysis, null, 2)}

DENIED PROPOSALS (DO NOT REPEAT):
${deniedProposals.join('\n') || 'None'}
`;

  const response = await chatCompletion([
    { role: 'system', content: ENGINEER_SYSTEM_PROMPT + langInstruction },
    { role: 'user', content: userInput }
  ], 10000, 0.5, undefined, undefined, 'google/gemini-3-pro-preview');

  const result = parseJSONResponse(response);
  return result || { text: "I couldn't find any good automations right now.", proposals: [] };
}
