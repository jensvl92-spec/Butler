/**
 * Proposal Validator Agent
 * Checks if a similar automation has been denied before and prevents nagging.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

const PROPOSAL_VALIDATOR_PROMPT = `
IDENTITY:
You are the "Do Not Disturb" registry for automation proposals.

TASK:
Determine if an automation proposal should be presented to the user based on denial history.

LOGIC:
1. Check if the proposal is semantically similar to any previously denied proposals (targets same entities/goal).
2. Denial Thresholds:
   - Denied 2+ times -> REJECT
   - Denied 1 time -> WARN
   - Never denied -> ALLOW

OUTPUT FORMAT (valid JSON ONLY):
{
  "decision": "ALLOW" | "WARN" | "REJECT",
  "reason": "Brief explanation",
  "similar_denied_proposal": "The text of the most similar denied proposal (or empty string)",
  "denial_count": 0
}
`;

export interface ProposalValidatorResult {
    decision: 'ALLOW' | 'WARN' | 'REJECT';
    reason: string;
    similar_denied_proposal?: string;
    denial_count: number;
}

export async function runProposalValidator(
    proposalText: string,
    deniedProposals: Array<{ text: string; count: number; reason: string }>
): Promise<ProposalValidatorResult> {
    if (!deniedProposals || deniedProposals.length === 0) {
        return {
            decision: 'ALLOW',
            reason: 'No previous denials on record',
            denial_count: 0
        };
    }

    const deniedContext = deniedProposals.map(d =>
        `- "${d.text}" (denied ${d.count}x, reason: ${d.reason})`
    ).join('\n');

    const response = await chatCompletion(
        [
            { role: 'system', content: PROPOSAL_VALIDATOR_PROMPT },
            { role: 'user', content: `PROPOSAL: ${proposalText}\n\nDENIED PROPOSALS:\n${deniedContext}` }
        ],
        500,
        0,
        undefined,
        undefined,
        undefined,
        { effort: 'low' },
        'lite_fast'
    );

    const result = parseJSONResponse(typeof response === 'string' ? response : JSON.stringify(response));
    return result || { decision: 'ALLOW', reason: 'Parse error - allowing', denial_count: 0 };
}
