/**
 * analyze-patterns/index.ts
 * Async Pattern Analysis Job (Analyzer -> AutomationEngineer -> ProposalValidator)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runAnalyzer } from '../_shared/agents/analyzer.ts';
import { runAutomationEngineer } from '../_shared/agents/automation-engineer.ts';
import { runProposalValidator } from '../_shared/agents/proposal-validator.ts';
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from '../_shared/auth.ts';
import { fetchHAStates } from '../_shared/ha-api.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_PROXY_URL = `${SUPABASE_URL}/functions/v1/mcp-proxy`;

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const startTime = Date.now();
    const log = (msg: string) => console.log(msg);

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) {
            return new Response(JSON.stringify({ error: auth.error }), {
                status: auth.status || 401,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        const raw = await req.text().catch(() => '');
        const body = raw.trim() ? JSON.parse(raw) : {};
        const connectionId = body.connection_id;
        const language = body.language || 'nl';

        if (!connectionId) {
            return new Response(JSON.stringify({ error: "connection_id required" }), {
                status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        const ownership = await verifyConnectionOwnership(supabase, auth, connectionId);
        if (!ownership.valid) {
            return new Response(JSON.stringify({ error: ownership.error }), {
                status: ownership.status || 403,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }
        const conn = ownership.connection;

        // Get entity IDs from mcp_raw_sync, with fallback to live HA states
        const { data: syncData } = await supabase
            .from('mcp_raw_sync')
            .select('toon_devices')
            .eq('connection_id', connectionId)
            .maybeSingle();

        let entityIds: string[] = [];
        if (syncData?.toon_devices) {
            const lines = syncData.toon_devices.split('\n').slice(1);
            entityIds = lines.map((line: string) => line.split('\t')[0]).filter(Boolean);
        }
        if (entityIds.length === 0) {
            const states = await fetchHAStates(conn);
            entityIds = states.map((s: any) => s.entity_id).filter(Boolean);
        }

        log(`[AnalyzePatterns] Starting analysis for ${connectionId} (${entityIds.length} entities)`);

        // === STEP 1: Run Analyzer ===
        const analysis = await runAnalyzer(
            connectionId,
            MCP_PROXY_URL,
            conn.api_url,
            conn.api_token,
            entityIds,
            body.focus_area || 'general',
            language,
            log
        );

        if (!analysis.patterns || analysis.patterns.length === 0) {
            return new Response(JSON.stringify({
                success: true,
                patterns: 0,
                proposals: 0,
                message: "Geen nieuwe patronen ontdekt in de afgelopen 3 dagen."
            }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }

        // === STEP 2: Run AutomationEngineer ===
        const { data: rejectedSuggestions } = await supabase
            .from('suggestions')
            .select('title, description, reasoning')
            .eq('connection_id', connectionId)
            .eq('status', 'rejected');

        const deniedProposals = (rejectedSuggestions || []).map((s: any) => ({
            text: `${s.title}: ${s.description || s.reasoning || ''}`,
            count: 1,
            reason: 'User rejected'
        }));

        const engineerResult = await runAutomationEngineer(
            analysis.patterns,
            deniedProposals.map(d => d.text),
            language
        );

        // === STEP 3: Validate and Save Proposals ===
        const rawProposals = engineerResult.proposals || [];
        let savedCount = 0;

        for (const proposal of rawProposals) {
            const validation = await runProposalValidator(
                `${proposal.title}: ${proposal.reasoning}`,
                deniedProposals
            );

            if (validation.decision === 'REJECT') {
                log(`[AnalyzePatterns] Skipping rejected proposal: ${proposal.title}`);
                continue;
            }

            const haAuto = proposal.ha_automation || {
                alias: proposal.title,
                description: proposal.reasoning || '',
                mode: 'single'
            };

            const { error } = await supabase.from('suggestions').insert({
                connection_id: connectionId,
                title: proposal.title,
                description: proposal.reasoning || '',
                trigger: proposal.trigger,
                condition: proposal.condition,
                actions: [{
                    type: 'create_automation',
                    ha_automation: haAuto,
                    data: haAuto,
                    action: proposal.action
                }],
                reasoning: proposal.reasoning,
                status: 'pending',
                type: 'automation_proposal'
            });

            if (!error) {
                savedCount++;
            } else {
                log(`[AnalyzePatterns] Failed to save proposal: ${error.message}`);
            }
        }

        // === STEP 4: Send FCM Notification ===
        if (conn.fcm_token && savedCount > 0) {
            try {
                const { sendFCM } = await import("../_shared/firebase.ts");
                const title = language.startsWith('nl')
                    ? `Ik vond ${savedCount} automatiseringsideeën!`
                    : `I found ${savedCount} automation ideas!`;
                const msgBody = language.startsWith('nl')
                    ? `Open Butler om je suggesties te bekijken.`
                    : `Open Butler to review your suggestions.`;

                await sendFCM(conn.fcm_token, title, msgBody, 'SUGGESTIONS', { type: 'suggestions', count: String(savedCount) });
            } catch (fcmError) {
                log(`[AnalyzePatterns] FCM error: ${fcmError}`);
            }
        }

        const totalTime = Date.now() - startTime;
        return new Response(JSON.stringify({
            success: true,
            patterns: analysis.patterns.length,
            proposals: savedCount,
            time_ms: totalTime,
            message: `${analysis.patterns.length} patronen gevonden, ${savedCount} automatiseringsvoorstel(len) klaargezet.`
        }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    } catch (err: any) {
        console.error('[AnalyzePatterns] Error:', err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }
});
