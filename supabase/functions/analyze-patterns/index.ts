/**
 * analyze-patterns/index.ts
 * 
 * Async Pattern Analysis Job
 * Runs Analyzer + AutomationEngineer in background, saves proposals to suggestions table.
 * Sends FCM notification when complete.
 */

// @ts-ignore
import { createClient } from "npm:@supabase/supabase-js@2.38.4"
import { runAnalyzer } from '../_shared/agents/analyzer.ts'
import { runAutomationEngineer } from '../_shared/agents/automation-engineer.ts'
import { runProposalValidator } from '../_shared/agents/proposal-validator.ts'

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

// @ts-ignore
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
// @ts-ignore
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
// MCP Proxy URL for analyzer
const MCP_PROXY_URL = `${SUPABASE_URL}/functions/v1/mcp-proxy`

// @ts-ignore
Deno.serve(async (req: Request) => {
    console.log('[AnalyzePatterns] ======= FUNCTION INVOKED =======');
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

    const startTime = Date.now();
    const log = (msg: string) => console.log(msg);

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

        // Parse request body
        const body = await req.json().catch(() => ({}));
        const connectionId = body.connection_id;
        const language = body.language || 'en';

        if (!connectionId) {
            return new Response(JSON.stringify({ error: "connection_id required" }), {
                status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        log(`[AnalyzePatterns] Starting async analysis for ${connectionId}`);

        // Get connection details (HA URL, token, FCM token)
        const { data: conn } = await supabase
            .from('ha_connections')
            .select('api_url, api_token, fcm_token')
            .eq('id', connectionId)
            .single();

        if (!conn) {
            return new Response(JSON.stringify({ error: "Connection not found" }), {
                status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Get device list for history fetching (from mcp_raw_sync, not ha_connections)
        const { data: syncData } = await supabase
            .from('mcp_raw_sync')
            .select('toon_devices')
            .eq('connection_id', connectionId)
            .single();

        // Parse entity IDs from TOON devices
        let entityIds: string[] = [];
        if (syncData?.toon_devices) {
            const lines = syncData.toon_devices.split('\n').slice(1); // Skip header
            entityIds = lines.map((line: string) => line.split('\t')[0]).filter(Boolean);
        }

        log(`[AnalyzePatterns] Found ${entityIds.length} entities`);

        // === STEP 1: Run Analyzer ===
        log('[AnalyzePatterns] Running Analyzer...');
        const analyzerStart = Date.now();

        const analysis = await runAnalyzer(
            connectionId,
            MCP_PROXY_URL,
            conn.api_url,
            conn.api_token,
            entityIds,
            'general',
            language,
            log
        );

        log(`[AnalyzePatterns] Analyzer done in ${Date.now() - analyzerStart}ms. Found ${analysis.patterns?.length || 0} patterns`);

        if (!analysis.patterns || analysis.patterns.length === 0) {
            log('[AnalyzePatterns] No patterns found, skipping AutomationEngineer');
            return new Response(JSON.stringify({
                success: true,
                patterns: 0,
                proposals: 0,
                message: "No patterns found"
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // === STEP 2: Run AutomationEngineer ===
        log('[AnalyzePatterns] Running AutomationEngineer...');
        const engineerStart = Date.now();

        // Get rejected proposals from suggestions table
        const { data: rejectedSuggestions } = await supabase
            .from('suggestions')
            .select('title, description, reasoning')
            .eq('connection_id', connectionId)
            .eq('status', 'rejected');

        const deniedProposals = (rejectedSuggestions || []).map((s: any) => ({
            text: `${s.title}: ${s.description || s.reasoning}`,
            count: 1, // Simple count for now
            reason: 'User rejected'
        }));

        const engineerResult = await runAutomationEngineer(
            analysis.patterns,
            [], // Engineer handles patterns, we validate after
            language
        );

        log(`[AnalyzePatterns] AutomationEngineer done in ${Date.now() - engineerStart}ms. Generated ${engineerResult.proposals?.length || 0} proposals`);

        // === STEP 3: Validate and Save Proposals ===
        const rawProposals = engineerResult.proposals || [];
        let savedCount = 0;

        for (const proposal of rawProposals) {
            // Validate against denied history
            const validation = await runProposalValidator(
                `${proposal.title}: ${proposal.reasoning}`,
                deniedProposals
            );

            if (validation.decision === 'REJECT') {
                log(`[AnalyzePatterns] Skipping rejected proposal: ${proposal.title} (Reason: ${validation.reason})`);
                continue;
            }

            const { error } = await supabase.from('suggestions').insert({
                connection_id: connectionId,
                title: proposal.title,
                description: proposal.reasoning || '',
                trigger: proposal.trigger,
                condition: proposal.condition,
                actions: [{ type: 'create_automation', action: proposal.action }],
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

        log(`[AnalyzePatterns] Saved ${savedCount}/${rawProposals.length} proposals to suggestions table`);

        // === STEP 4: Send FCM Notification ===
        if (conn.fcm_token && savedCount > 0) {
            try {
                const { sendFCM } = await import("../_shared/firebase.ts");
                const title = language.startsWith('nl')
                    ? `Ik vond ${savedCount} automatisering ideeën!`
                    : `I found ${savedCount} automation ideas!`;
                const body = language.startsWith('nl')
                    ? `Zeg "Toon mijn suggesties" om ze te bekijken.`
                    : `Say "Show my suggestions" to view them.`;

                await sendFCM(conn.fcm_token, title, body, 'SUGGESTIONS', { type: 'suggestions', count: String(savedCount) });
                log('[AnalyzePatterns] FCM notification sent');
            } catch (fcmError) {
                log(`[AnalyzePatterns] FCM error: ${fcmError}`);
            }
        }

        const totalTime = Date.now() - startTime;
        log(`[AnalyzePatterns] Complete in ${totalTime}ms`);

        return new Response(JSON.stringify({
            success: true,
            patterns: analysis.patterns.length,
            proposals: savedCount,
            time_ms: totalTime
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (err: any) {
        console.error('[AnalyzePatterns] Error:', err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
})
