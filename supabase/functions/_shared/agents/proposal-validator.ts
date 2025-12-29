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
1. Check if the proposal is semantically similar to any previously denied proposals
2. If denied 3+ times → REJECT (user clearly doesn't want this)
3. If denied 1-2 times → WARN but allow
4. If never denied → ALLOW

OUTPUT FORMAT:
{
  "decision": "ALLOW" | "WARN" | "REJECT",
  "reason": "Explanation",
  "similar_denied_proposal": "The similar proposal that was denied (if any)",
  "denial_count": 0
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
    ], 200, 0);

    const result = parseJSONResponse(response);
    return result || { decision: 'ALLOW', reason: 'Parse error - allowing', denial_count: 0 };
}
