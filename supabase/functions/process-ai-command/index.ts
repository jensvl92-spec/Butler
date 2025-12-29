/**
 * Process AI Command - Supabase Edge Function
 * 
 * Main entry point for Butler AI requests.
 * 
 * FLOW:
 * 1. BOUNCER - Validates intent (rejects off-topic)
 * 2. ROUTER  - Selects relevant tools/agents from MCP proxy
 * 3. BUTLER  - Orchestrates using selected tools, or delegates
 * 4. SPECIALIST - Handles delegated requests
 * 
 * MCP Proxy provides tools and device data from synced Home Assistant.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { runBouncer } from '../_shared/agents/bouncer.ts';
import { runButler } from '../_shared/agents/butler.ts';
import { runPersonalAssistant } from '../_shared/agents/personal-assistant.ts';
import { runAutomationHandler } from '../_shared/agents/automation-handler.ts';
import { runAutomationCreator } from '../_shared/agents/automation-creator.ts';
import { runAnalyzer } from '../_shared/agents/analyzer.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

interface RequestPayload {
    connection_id: string;
    user_message: string;
    language?: string;
    devices?: any[];  // Optional - MCP proxy has device data
}

interface AIResponse {
    text: string;
    actions: Array<{
        entity_id: string;
        service: string;
        data?: Record<string, any>;
    }>;
    language: string;
    logs?: string[];
    automation_yaml?: string;
    requires_confirmation?: boolean;
}

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const logs: string[] = [];
    const log = (msg: string) => { console.log(msg); logs.push(msg); };

    try {
        const payload: RequestPayload = await req.json();
        const { connection_id, user_message, language = 'en' } = payload;

        log(`[Butler] Request from ${connection_id}: "${user_message}"`);

        if (!user_message?.trim()) {
            return jsonResponse({
                text: language === 'nl' ? 'Geen bericht ontvangen.' : 'No message received.',
                actions: [], language, logs
            });
        }

        // MCP Proxy URL (same Supabase instance)
        const mcpProxyUrl = `${SUPABASE_URL}/functions/v1/mcp-proxy`;

        // ============================================
        // STEP 1: BOUNCER - Validate Intent
        // ============================================
        log('[Bouncer] Validating...');
        const bouncer = await runBouncer(user_message, language);
        log(`[Bouncer] valid=${bouncer.is_valid}, type=${bouncer.intent_type}`);

        if (!bouncer.is_valid) {
            return jsonResponse({
                text: bouncer.rejection_message || 'I can\'t help with that.',
                actions: [], language, logs
            });
        }

        // ============================================
        // STEP 2-3: BUTLER (includes ROUTER internally)
        // ============================================
        log('[Butler] Processing with tool calling...');
        const butler = await runButler(user_message, mcpProxyUrl, connection_id, language);
        log(`[Butler] Done. Actions: ${butler.actions?.length || 0}, Delegate: ${butler.delegate_to || 'none'}`);

        // ============================================
        // STEP 4: Handle Delegation
        // ============================================
        if (butler.delegate_to) {
            log(`[Delegation] → ${butler.delegate_to}`);

            switch (butler.delegate_to) {
                case 'personal_assistant': {
                    const result = await runPersonalAssistant(user_message, '', '', language);
                    return jsonResponse({ text: result.text, actions: result.actions || [], language, logs });
                }

                case 'automation_creator': {
                    // Fetch device context for automation creation
                    const devicesResp = await fetch(`${mcpProxyUrl}/tools/get_lights`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ connection_id, args: {} })
                    });
                    const { result: devices } = await devicesResp.json();
                    const context = JSON.stringify(devices || []);

                    const result = await runAutomationCreator(user_message, context, language);
                    return jsonResponse({
                        text: result.text,
                        actions: [],
                        language, logs,
                        automation_yaml: result.automation_yaml,
                        requires_confirmation: result.requires_confirmation
                    });
                }

                case 'automation_handler': {
                    const autoResp = await fetch(`${mcpProxyUrl}/tools/get_automations`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ connection_id, args: {} })
                    });
                    const { result: automations } = await autoResp.json();
                    const context = (automations || []).map((a: any) => `${a.entity_id}: ${a.state}`).join('\n');

                    const result = await runAutomationHandler(user_message, context, language);
                    return jsonResponse({ text: result.text, actions: result.actions || [], language, logs });
                }

                case 'analyzer': {
                    const result = await runAnalyzer('No history data available', 'general', language);
                    return jsonResponse({ text: result.text, actions: [], language, logs });
                }

                default:
                    log(`[Delegation] Unknown agent: ${butler.delegate_to}`);
            }
        }

        // ============================================
        // STEP 5: Return Butler's Response
        // ============================================
        return jsonResponse({
            text: butler.text,
            actions: butler.actions || [],
            language, logs
        });

    } catch (error: any) {
        console.error('[Error]', error);
        return jsonResponse({
            text: 'Sorry, something went wrong.',
            actions: [],
            language: 'en',
            logs: [...logs, `Error: ${error.message}`]
        }, 500);
    }
});

function jsonResponse(data: AIResponse, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}
