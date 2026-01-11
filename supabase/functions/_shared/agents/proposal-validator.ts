/**
 * Proposal Validator Agent
 * 
 * The "Do Not Disturb" registry for automation proposals.
 * Checks if a similar automation has been denied before and prevents nagging.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

const PROPOSAL_VALIDATOR_PROMPT = `
IDENTITY:
You are the "Do Not Disturb" registry for automation proposals.

TASK:
Determine if an automation proposal should be presented to the user based on denial history.

LOGIC:
1. Check if the proposal is semantically similar to any previously denied proposals.
   - **Semantic Similarity**: A proposal is similar if it targets the same entities and achieves the same goal (e.g., "Turn on office lights when I enter" is similar to "Auto office lights at 7pm").
2. **Denial Thresholds**:
   - If a similar proposal was denied **3+ times** → **REJECT** (User clearly doesn't want this category of automation).
   - If denied **1-2 times** → **WARN** (Mention it has been rejected before but might be relevant now).
   - If never denied → **ALLOW**.
3. **Reasoning**: Explain why you made the decision, citing the similar denied proposal if applicable.

OUTPUT FORMAT:
{
  "decision": "ALLOW" | "WARN" | "REJECT",
  "reason": "Brief explanation",
  "similar_denied_proposal": "The text of the most similar denied proposal",
  "denial_count": number
}
`;

export interface ProposalValidatorResult {
    decision: 'ALLOW' | 'WARN' | 'REJECT';
    reason: string;
    similar_denied_proposal?: string;
    denial_count: number;
}

/**
 * Validate if a proposal should be shown to the user.
 * 
 * @param proposalText - The automation proposal to validate
 * @param deniedProposals - List of previously denied proposals
 */
export async function runProposalValidator(
    proposalText: string,
    deniedProposals: Array<{ text: string; count: number; reason: string }>
): Promise<ProposalValidatorResult> {
    console.log(`[ProposalValidator] Checking proposal against ${deniedProposals.length} denied items`);

    // Quick check - if no denied proposals, always allow
    if (deniedProposals.length === 0) {
        return {
            decision: 'ALLOW',
            reason: 'No previous denials on record',
            denial_count: 0
        };
    }

    const deniedContext = deniedProposals.map(d =>
        `- "${d.text}" (denied ${d.count}x, reason: ${d.reason})`
    ).join('\n');

    const response = await chatCompletion([
        { role: 'system', content: PROPOSAL_VALIDATOR_PROMPT },
        { role: 'user', content: `PROPOSAL: ${proposalText}\n\nDENIED PROPOSALS:\n${deniedContext}` }
    ], 2000, 0, undefined, undefined, 'deepseek/deepseek-chat');

    const result = parseJSONResponse(response);
    return result || { decision: 'ALLOW', reason: 'Parse error - allowing', denial_count: 0 };
}
