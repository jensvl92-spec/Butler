/**
 * Process AI Command - Supabase Edge Function
 * 
 * Main entry point for Butler AI requests.
 * 
 * FLOW:
 * 1. App sends: { connection_id, user_message, language }
 * 2. Bouncer validates intent
 * 3. Butler (with single query_mcp tool)
 * 4. query_mcp triggers Router → searches MCP database
 * 5. Returns actions for app to execute
 * 
 * NO DEVICES IN REQUEST - all tools come from MCP database!
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parse as parseYAML } from "https://deno.land/std@0.168.0/encoding/yaml.ts";
import { runBouncer } from '../_shared/agents/bouncer.ts';
import { runButler, runButlerWithContext } from '../_shared/agents/butler.ts';
import { selectToolsFromMCP } from '../_shared/agents/router.ts';
import { runPersonalAssistant } from '../_shared/agents/personal-assistant.ts';
import { runAutomationHandler } from '../_shared/agents/automation-handler.ts';
import { runAutomationCreator } from '../_shared/agents/automation-creator.ts';
import { runAnalyzer } from '../_shared/agents/analyzer.ts';
import { runAutomationEngineer } from '../_shared/agents/automation-engineer.ts';
import { runRecipeChef } from '../_shared/agents/recipe-chef.ts';
import { createHAAutomation } from '../_shared/ha-api.ts';
import { scheduleActions } from '../_shared/action-executor.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Initialize Supabase client for database operations
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface RequestPayload {
    connection_id: string;
    user_message: string;
    language?: string;
}

interface AIResponse {
    text: string;
    actions: Array<{
        entity_id: string;
        service: string;
        data?: Record<string, any>;
    }>;
    scheduled_actions?: any[];
    language: string;
    logs?: string[];
    automation_yaml?: string;
    requires_confirmation?: boolean;
    conversation_mode?: boolean;
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
    const startTime = Date.now();
    const log = (msg: string) => { console.log(msg); logs.push(msg); };
    const logTime = (step: string) => {
        const elapsed = Date.now() - startTime;
        log(`[TIMING] ${step}: ${elapsed}ms`);
    };

    try {
        const payload: RequestPayload = await req.json();
        const { connection_id, user_message, language = 'en', mcp_proxy_url: clientProxyUrl, devices = [], ha_url = '', ha_token = '', location = null, gps_unavailable = false } = payload as any;

        logTime('Request parsed');
        log(`[Butler] Request: "${user_message}"`);

        if (!user_message?.trim()) {
            return jsonResponse({
                text: language === 'nl' ? 'Geen bericht ontvangen.' : 'No message received.',
                actions: [], language, logs
            });
        }

        // MCP Proxy URL (Default to Supabase, but allow override from client)
        const mcpProxyUrl = clientProxyUrl || `${SUPABASE_URL}/functions/v1/mcp-proxy`;

        // === Helper: Get History ===
        const getChatHistory = async (connectionId: string): Promise<any[]> => {
            try {
                const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
                // Fetch last 6 inputs/outputs
                const { data, error } = await supabase
                    .from('chat_history')
                    .select('user_message, ai_response, actions_taken')
                    .eq('connection_id', connectionId)
                    .order('created_at', { ascending: false })
                    .limit(6);

                if (error) throw error;
                if (!data) return [];

                // Convert to LLM message format (reverse order: oldest to newest)
                return data.reverse().flatMap((row: any) => {
                    const aiText = typeof row.ai_response === 'string' ? row.ai_response : (row.ai_response?.text || '');
                    const actionContext = (row.actions_taken && row.actions_taken.length > 0)
                        ? `\n[Actions: ${row.actions_taken.map((a: any) => `${a.service}(${a.entity_id})`).join(', ')}]`
                        : '';

                    return [
                        { role: 'user', content: row.user_message },
                        { role: 'assistant', content: aiText + actionContext }
                    ];
                });
            } catch (e) {
                console.error('[History] Failed to load:', e);
                return [];
            }
        };

        // === Helper to Save History & Return ===
        const sendResponse = async (data: AIResponse) => {
            // Debug: Log what we're saving
            console.log(`[SaveHistory] Saving with ${data.actions?.length || 0} actions`);

            try {
                const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
                const insertPayload = {
                    connection_id,
                    user_message,
                    ai_response: data, // JSONB: stores text, actions, logs
                    actions_taken: data.actions || [],
                    metadata: { language: data.language }
                };

                const { error } = await supabase.from('chat_history').insert(insertPayload);

                if (error) {
                    console.error('[SaveHistory] Insert error:', JSON.stringify(error));
                } else {
                    console.log('[SaveHistory] Saved successfully');
                }
            } catch (e) {
                console.error('Failed to save chat history:', e);
            }
            return jsonResponse(data);
        };

        // === STEP 0: FETCH HISTORY ===
        // We fetch history EARLY so Bouncer can see context (e.g. "Yes, please" -> connected to previous Q)
        const recentHistory = await getChatHistory(connection_id);
        logTime('History fetched');

        // === STEP 1: BOUNCER + ROUTER IN PARALLEL ===
        // Start both, but await selectively: Personal Assistant doesn't need Router
        log('[Bouncer] Validating...');
        log('[Router] Pre-fetching tools/devices (parallel)...');

        const bouncerHistory = recentHistory.map((m: any) => ({ role: m.role, content: m.content }));

        // Start both operations in parallel (non-blocking)
        const bouncerPromise = runBouncer(user_message, language, bouncerHistory);
        const routerPromise = selectToolsFromMCP(user_message, mcpProxyUrl, connection_id);

        // Await Bouncer first to determine routing
        const bouncer = await bouncerPromise;
        logTime('Bouncer done');
        log(`[Bouncer] valid=${bouncer.is_valid}, type=${bouncer.intent_type}`);

        if (!bouncer.is_valid) {
            return await sendResponse({
                text: bouncer.rejection_message || 'I can\'t help with that.',
                actions: [], language, logs
            });
        }

        // === Personal Assistant Intents ===
        // Don't wait for Router - proceed immediately
        const paIntents = ['weather', 'navigation', 'calendar', 'email', 'music', 'tasks', 'messaging', 'briefing', 'expenses', 'sheets', 'docs'];
        if (paIntents.includes(bouncer.intent_type)) {
            log(`[PersonalAssistant] 🚨 INTENT MATCHED: ${bouncer.intent_type}`);
            log(`[PersonalAssistant] Skipping Router, calling runPersonalAssistant directly...`);

            // [SECURITY FIX] Resolve User ID from Connection ID
            // We must ensure actions are performed for the owner of the connection, not a default user.
            const { data: conn } = await supabase
                .from('ha_connections')
                .select('user_id')
                .eq('id', connection_id)
                .single();

            const userId = conn?.user_id;

            if (!userId) {
                log('[PersonalAssistant] ❌ Security Error: Could not resolve user_id from connection_id');
                return await sendResponse({
                    text: language.startsWith('nl')
                        ? 'Er is een beveiligingsfout opgetreden. Ik kan je gebruiker niet verifiëren. (Connection/User mismatch)'
                        : 'Security error: I cannot verify your user identity. (Connection/User mismatch)',
                    actions: [], language, logs
                });
            }

            const result = await runPersonalAssistant(user_message, '', '', userId, language, location, bouncer.intent_type, log, recentHistory, (payload as any).client_timestamp, (payload as any).client_timezone, gps_unavailable);

            log(`[PersonalAssistant] executed. Result text: ${result.text.substring(0, 50)}...`);
            return await sendResponse({ text: result.text, actions: result.actions || [], language, logs });
        }

        // === Recipe Chef Intent ===
        // Delegate recipe handling to specialized agent
        if (bouncer.intent_type === 'recipe') {
            log('[RecipeChef] → Recipe intent detected');

            // Get recipe context from history (if continuing a recipe)
            const recipeContext = recentHistory
                .filter((m: any) => m.content?.includes('Step') || m.content?.includes('recipe'))
                .map((m: any) => m.content)
                .join('\n');

            const historyForChef = recentHistory
                .map((m: any) => `${m.role.toUpperCase()}: ${m.content}`)
                .join('\n');

            const result = await runRecipeChef(user_message, recipeContext, historyForChef, language, log);
            logTime('RecipeChef done');

            return await sendResponse({
                text: result.text,
                actions: result.actions || [],
                language,
                logs,
                conversation_mode: result.conversation_mode
            } as any);
        }

        // === Automation Create Intent ===
        // Direct routing to AutomationCreator for recurring automation requests
        // This bypasses Butler to prevent hallucination of automations
        if (bouncer.intent_type === 'automation_create') {
            log('[AutomationCreator] → Recurring automation request detected');

            // Build entity context from devices
            const entityContext = (devices || [])
                .slice(0, 50)
                .map((d: any) => `${d.entity_id}: ${d.state}`)
                .join('\n');

            const creatorResult = await runAutomationCreator(user_message, entityContext, language);
            logTime('AutomationCreator done');

            log(`[AutomationCreator] Generated YAML: ${creatorResult.automation_yaml?.substring(0, 100)}...`);

            return await sendResponse({
                text: creatorResult.text,
                actions: [],
                language,
                logs,
                automation_yaml: creatorResult.automation_yaml,
                requires_confirmation: creatorResult.requires_confirmation
            });
        }

        // === Automation Manage Intent ===
        // Direct routing to AutomationHandler for managing existing automations
        if (bouncer.intent_type === 'automation_manage') {
            log('[AutomationHandler] → Automation management request detected');

            // Fetch existing automations from MCP
            const autoResp = await fetch(`${mcpProxyUrl}/tools/get_automations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connection_id, args: {} })
            });
            const { result: automations } = await autoResp.json();
            const automationContext = (automations || []).map((a: any) => `${a.entity_id}: ${a.state}`).join('\n');

            const handlerResult = await runAutomationHandler(user_message, automationContext, language);
            logTime('AutomationHandler done');

            return await sendResponse({
                text: handlerResult.text,
                actions: handlerResult.actions || [],
                language,
                logs
            });
        }

        // === Analyzer Intent ===
        // Trigger async pattern analysis (fire-and-forget)
        if (bouncer.intent_type === 'analyzer') {
            log('[Analyzer] → Triggering async analysis...');

            // Fire-and-forget: trigger analyze-patterns in background
            const analyzeUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/analyze-patterns`;
            const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
            const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
            fetch(analyzeUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': anonKey || serviceKey || '',
                    'Authorization': `Bearer ${serviceKey}`
                },
                body: JSON.stringify({
                    connection_id,
                    language
                })
            }).catch(err => console.error('[Analyzer] Async trigger failed:', err));

            // Return immediately with friendly message
            const responseText = language.startsWith('nl')
                ? 'Ik analyseer nu je patronen. Ik stuur je een melding zodra ik klaar ben met suggesties.'
                : "I'm analyzing your patterns now. I'll send you a notification when I have suggestions ready.";

            return await sendResponse({
                text: responseText,
                actions: [],
                language,
                logs,
            });
        }

        // === View Suggestions Intent ===
        // Show pending automation suggestions from database
        if (bouncer.intent_type === 'view_suggestions') {
            log('[Suggestions] → View pending suggestions');

            const { data: suggestions } = await supabase
                .from('suggestions')
                .select('id, title, trigger, condition, reasoning, created_at')
                .eq('connection_id', connection_id)
                .eq('status', 'pending')
                .order('created_at', { ascending: false })
                .limit(10);

            if (!suggestions || suggestions.length === 0) {
                const noSuggestionsText = language.startsWith('nl')
                    ? 'Je hebt momenteel geen openstaande suggesties. Zeg "Geef me suggesties" om je patronen te analyseren.'
                    : 'You have no pending suggestions. Say "Give me suggestions" to analyze your patterns.';

                return await sendResponse({
                    text: noSuggestionsText,
                    actions: [],
                    language,
                    logs,
                });
            }

            // Format suggestions as numbered list
            const suggestionList = suggestions.map((s, i) =>
                `${i + 1}. **${s.title}**\n   ${language.startsWith('nl') ? 'Trigger' : 'When'}: ${s.trigger || 'N/A'}\n   ${language.startsWith('nl') ? 'Reden' : 'Why'}: ${s.reasoning || 'N/A'}`
            ).join('\n\n');

            const headerText = language.startsWith('nl')
                ? `Ik heb ${suggestions.length} suggesties voor je:\n\n`
                : `I have ${suggestions.length} suggestions for you:\n\n`;

            const footerText = language.startsWith('nl')
                ? '\n\nZeg "Accepteer nummer X" om een automatisering aan te maken, of "Accepteer X maar om 10 uur" om aan te passen.'
                : '\n\nSay "Accept number X" to create an automation, or "Accept X but at 10 PM" to modify.';

            return await sendResponse({
                text: headerText + suggestionList + footerText,
                actions: [],
                language,
                logs,
            });
        }

        // === Approve Suggestion Intent ===
        // Create automation from a pending suggestion (with optional modifications)
        if (bouncer.intent_type === 'approve_suggestion') {
            log('[Suggestions] → Approve suggestion');

            // Get pending suggestions
            const { data: suggestions } = await supabase
                .from('suggestions')
                .select('*')
                .eq('connection_id', connection_id)
                .eq('status', 'pending')
                .order('created_at', { ascending: false })
                .limit(10);

            if (!suggestions || suggestions.length === 0) {
                const noSuggestionsText = language.startsWith('nl')
                    ? 'Je hebt geen openstaande suggesties om te accepteren.'
                    : 'You have no pending suggestions to accept.';

                return await sendResponse({
                    text: noSuggestionsText,
                    actions: [],
                    language,
                    logs,
                });
            }

            // Parse which suggestion number from user message
            const numberMatch = user_message.match(/\d+/);
            const suggestionIndex = numberMatch ? parseInt(numberMatch[0]) - 1 : 0;

            if (suggestionIndex < 0 || suggestionIndex >= suggestions.length) {
                return await sendResponse({
                    text: language.startsWith('nl')
                        ? `Ik heb suggesties 1 tot ${suggestions.length}. Welke wil je accepteren?`
                        : `I have suggestions 1 to ${suggestions.length}. Which one would you like to accept?`,
                    actions: [],
                    language,
                    logs,
                });
            }

            const selectedSuggestion = suggestions[suggestionIndex];
            log(`[Suggestions] Selected suggestion: ${selectedSuggestion.title}`);

            // Check if user wants modifications
            const hasModification = user_message.toLowerCase().includes('but') ||
                user_message.toLowerCase().includes('maar') ||
                user_message.toLowerCase().includes('om ');

            if (hasModification) {
                // Call AutomationEngineer to finetune the proposal
                log('[Suggestions] User requested modification, calling AutomationEngineer...');
                const modificationRequest = user_message;

                const engineerResult = await runAutomationEngineer(
                    [{ ...selectedSuggestion, modification: modificationRequest }],
                    [],
                    language
                );

                // Get the modified proposal and send to AutomationCreator
                const modifiedProposal = engineerResult.proposals?.[0];
                if (modifiedProposal) {
                    // Build entity context from devices
                    const entityContext = (devices || [])
                        .slice(0, 50)
                        .map((d: any) => `${d.entity_id}: ${d.state}`)
                        .join('\n');

                    // Create the automation
                    const creatorMessage = `Create automation: ${modifiedProposal.title}. Trigger: ${modifiedProposal.trigger}. Condition: ${modifiedProposal.condition || 'None'}. Action: ${modifiedProposal.action}`;
                    const creatorResult = await runAutomationCreator(creatorMessage, entityContext, language);

                    log(`[Suggestions] AutomationCreator generated YAML: ${creatorResult.automation_yaml?.substring(0, 100)}...`);

                    // Update suggestion to approved with generated YAML
                    await supabase
                        .from('suggestions')
                        .update({
                            status: 'approved',
                            ha_automation: creatorResult.automation_yaml
                        })
                        .eq('id', selectedSuggestion.id);

                    return await sendResponse({
                        text: creatorResult.text || (language.startsWith('nl')
                            ? `Ik heb de automatisering "${modifiedProposal.title}" aangemaakt!`
                            : `I've created the automation "${modifiedProposal.title}"!`),
                        actions: creatorResult.automation_yaml ? [{
                            type: 'create_automation',
                            automation_yaml: creatorResult.automation_yaml
                        }] : [],
                        language,
                        logs,
                    });
                }

                return await sendResponse({
                    text: engineerResult.text || (language.startsWith('nl')
                        ? `Ik heb de automatisering "${selectedSuggestion.title}" aangepast. Ik zal dit binnenkort implementeren.`
                        : `I've modified the automation "${selectedSuggestion.title}". I'll implement this shortly.`),
                    actions: [],
                    language,
                    logs,
                });
            }

            // Build entity context for AutomationCreator
            const entityContext = (devices || [])
                .slice(0, 50)
                .map((d: any) => `${d.entity_id}: ${d.state}`)
                .join('\n');

            // Create the automation using AutomationCreator
            log('[Suggestions] Calling AutomationCreator...');
            const creatorMessage = `Create automation: ${selectedSuggestion.title}. Trigger: ${selectedSuggestion.trigger}. Condition: ${selectedSuggestion.condition || 'None'}. Action: ${selectedSuggestion.description || selectedSuggestion.reasoning}`;
            const creatorResult = await runAutomationCreator(creatorMessage, entityContext, language);

            log(`[Suggestions] AutomationCreator generated YAML: ${creatorResult.automation_yaml?.substring(0, 100)}...`);

            // Parse YAML to JSON and create automation in HA
            let automationId = null;
            if (creatorResult.automation_yaml) {
                try {
                    const automationConfig = parseYAML(creatorResult.automation_yaml) as any;
                    log(`[Suggestions] Creating automation in HA: ${automationConfig.alias}`);

                    // Get connection for HA API call
                    const { data: conn } = await supabase
                        .from('ha_connections')
                        .select('api_url, api_token')
                        .eq('id', connection_id)
                        .single();

                    if (conn) {
                        automationId = await createHAAutomation(
                            { api_url: conn.api_url, api_token: conn.api_token } as any,
                            automationConfig,
                            automationConfig.alias || selectedSuggestion.title
                        );
                        log(`[Suggestions] ✅ Created automation in HA: ${automationId}`);
                    }
                } catch (yamlError) {
                    log(`[Suggestions] ⚠️ Failed to create automation: ${yamlError}`);
                }
            }

            // Mark as approved and store generated YAML
            await supabase
                .from('suggestions')
                .update({
                    status: automationId ? 'approved' : 'pending',
                    ha_automation: creatorResult.automation_yaml
                })
                .eq('id', selectedSuggestion.id);

            const successText = automationId
                ? (language.startsWith('nl')
                    ? `✅ Automatisering "${selectedSuggestion.title}" is aangemaakt in Home Assistant!`
                    : `✅ Automation "${selectedSuggestion.title}" has been created in Home Assistant!`)
                : (language.startsWith('nl')
                    ? `⚠️ Ik heb de automatisering gegenereerd maar kon hem niet installeren. Controleer de logs.`
                    : `⚠️ I generated the automation but couldn't install it. Check the logs.`);

            return await sendResponse({
                text: successText,
                actions: [],  // Already created in HA, no client action needed
                language,
                logs,
            });
        }

        // === Reject Suggestion Intent ===
        // Mark a pending suggestion as rejected
        if (bouncer.intent_type === 'reject_suggestion') {
            log('[Suggestions] → Reject suggestion');

            // Get pending suggestions to find the right one
            const { data: suggestions } = await supabase
                .from('suggestions')
                .select('id, title')
                .eq('connection_id', connection_id)
                .eq('status', 'pending')
                .order('created_at', { ascending: false })
                .limit(10);

            if (!suggestions || suggestions.length === 0) {
                const noSuggestionsText = language.startsWith('nl')
                    ? 'Je hebt geen openstaande suggesties om te weigeren.'
                    : 'You have no pending suggestions to reject.';

                return await sendResponse({
                    text: noSuggestionsText,
                    actions: [],
                    language,
                    logs,
                });
            }

            // Parse which suggestion number from user message
            const numberMatch = user_message.match(/\d+/);
            const suggestionIndex = numberMatch ? parseInt(numberMatch[0]) - 1 : 0;

            if (suggestionIndex < 0 || suggestionIndex >= suggestions.length) {
                return await sendResponse({
                    text: language.startsWith('nl')
                        ? `Ik heb suggesties 1 tot ${suggestions.length}. Welke wil je weigeren?`
                        : `I have suggestions 1 to ${suggestions.length}. Which one would you like to reject?`,
                    actions: [],
                    language,
                    logs,
                });
            }

            const selectedSuggestion = suggestions[suggestionIndex];
            log(`[Suggestions] Rejecting suggestion: ${selectedSuggestion.title}`);

            // Mark as rejected
            await supabase
                .from('suggestions')
                .update({ status: 'rejected' })
                .eq('id', selectedSuggestion.id);

            const rejectionText = language.startsWith('nl')
                ? `Oké, ik heb de suggestie "${selectedSuggestion.title}" geweigerd. Ik zal deze niet meer voorstellen.`
                : `Okay, I've rejected the suggestion "${selectedSuggestion.title}". I won't propose it again.`;

            return await sendResponse({
                text: rejectionText,
                actions: [],
                language,
                logs,
            });
        }

        // === Butler Intents ===
        // Wait for Router before proceeding
        const routerResult = await routerPromise;
        logTime('Router done (awaited for Butler)');
        log(`[Router] Found: ${routerResult.devices?.length || 0} devices, ${routerResult.tools?.length || 0} tools`);

        // Create explicit map of device states for Butler to use
        const deviceStates: Record<string, string> = {};
        if (Array.isArray(devices)) {
            devices.forEach((d: any) => {
                if (d.entity_id && d.state) {
                    deviceStates[d.entity_id] = d.state;
                }
            });
        }


        // Format chat history for Butler context
        const historyForButler = recentHistory
            .map((m: any) => `${m.role.toUpperCase()}: ${m.content}`)
            .join('\n');

        // === GRAPH-SPECIFIC: Fetch matching sensors from HA ===
        let graphSensors: { entity_id: string; name: string; state: string }[] = [];
        if (bouncer.intent_type === 'graph' && ha_url && ha_token) {
            log('[Graph] Fetching sensors from HA for graph context...');
            try {
                // Keywords to match from user message
                const keywords = ['temperature', 'temperatuur', 'temp', 'humidity', 'vochtigheid',
                    'energy', 'energie', 'power', 'vermogen', 'consumption', 'verbruik',
                    'pressure', 'druk', 'battery', 'batterij', 'lux', 'luminance', 'illuminance',
                    'co2', 'pm25', 'air', 'lucht', 'voltage', 'current', 'stroom', 'watt',
                    'solar', 'zon', 'wind', 'rain', 'regen', 'weather', 'weer',
                    'binnen', 'buiten', 'indoor', 'outdoor', 'inside', 'outside'];

                // Find which keywords are in the user message
                const msgLower = user_message.toLowerCase();
                const matchingKeywords = keywords.filter(kw => msgLower.includes(kw));

                // Fetch all sensor states from HA
                const cleanHaUrl = ha_url.replace(/\/$/, '');
                const statesResp = await fetch(`${cleanHaUrl}/api/states`, {
                    headers: { 'Authorization': `Bearer ${ha_token}` }
                });

                if (statesResp.ok) {
                    const allStates = await statesResp.json();

                    // Filter to sensors that match keywords
                    graphSensors = allStates
                        .filter((s: any) => {
                            if (!s.entity_id.startsWith('sensor.')) return false;
                            // Skip non-numeric sensors
                            if (isNaN(parseFloat(s.state))) return false;

                            const entityLower = s.entity_id.toLowerCase();
                            const nameLower = (s.attributes?.friendly_name || '').toLowerCase();

                            // Match if any keyword appears in entity_id or friendly_name
                            return matchingKeywords.length === 0 ||
                                matchingKeywords.some(kw => entityLower.includes(kw) || nameLower.includes(kw));
                        })
                        .slice(0, 20) // Limit to avoid context overflow
                        .map((s: any) => ({
                            entity_id: s.entity_id,
                            name: s.attributes?.friendly_name || s.entity_id,
                            state: s.state,
                            unit: s.attributes?.unit_of_measurement || ''
                        }));

                    log(`[Graph] Found ${graphSensors.length} matching sensors for: ${matchingKeywords.join(', ') || 'all'}`);
                }
            } catch (e) {
                log(`[Graph] Sensor fetch failed: ${e}`);
            }
        }

        // === STEP 3: BUTLER with pre-loaded context (no tool calling!) ===
        log('[Butler] Processing with pre-loaded context...');

        // Build context with graph sensors if available
        const butlerDevices = (routerResult.devices || []).map((id: string) => ({ entity_id: id, state: deviceStates[id] || 'unknown' }));
        const graphSensorContext = graphSensors.length > 0
            ? `\n\nAVAILABLE SENSORS FOR GRAPHING:\n${graphSensors.map(s => `- ${s.entity_id}: "${s.name}" (${s.state} ${s.unit})`).join('\n')}\nUse these EXACT entity_ids in graph.create actions!`
            : '';

        const butler = await runButlerWithContext(
            user_message + graphSensorContext,
            {
                tools: routerResult.tools || [],
                devices: butlerDevices,
                memories: [],
                reasoning: routerResult.reasoning,
                agents: routerResult.agents
            },
            historyForButler,
            log,
            language
        );
        logTime('Butler done');
        log(`[Butler] Done. Actions: ${butler.actions?.length || 0}`);

        // === STEP 3: Handle Delegation ===
        if (butler.delegate_to) {
            log(`[Delegation] → ${butler.delegate_to}`);

            switch (butler.delegate_to) {
                case 'automation_creator': {
                    // Get device context from MCP for automation creation
                    const toolsResp = await fetch(`${mcpProxyUrl}/tools?connection_id=${connection_id}`);
                    const { tools } = await toolsResp.json();
                    const context = JSON.stringify((tools || []).slice(0, 30));

                    const result = await runAutomationCreator(user_message, context, language);
                    return await sendResponse({
                        text: result.text, actions: [], language, logs,
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
                    return await sendResponse({ text: result.text, actions: result.actions || [], language, logs });
                }

                case 'analyzer': {
                    // Extract entity IDs for history fetching
                    const entityIds = (devices || []).map((d: any) => d.entity_id);

                    // 1. Run Analyzer to find patterns
                    const analysis = await runAnalyzer(connection_id, mcpProxyUrl, ha_url, ha_token, entityIds, 'general', language, log);

                    // 2. Pass patterns to Automation Engineer for proposals
                    const deniedProposals: string[] = [];
                    const engineerResult = await runAutomationEngineer(analysis.patterns, deniedProposals, language);

                    return await sendResponse({
                        text: engineerResult.text,
                        actions: [],
                        language,
                        logs,
                    });
                }

                default:
                    log(`[Delegation] Unknown delegate_to: ${butler.delegate_to}, ignoring`);
            }
        }

        // === Handle Scheduled Actions (delayed commands like "in 10 minutes") ===
        if (butler.scheduled_actions && butler.scheduled_actions.length > 0) {
            log(`[Scheduler] Storing ${butler.scheduled_actions.length} scheduled actions`);
            await scheduleActions(butler.scheduled_actions, connection_id, supabase);
        }

        // === Return Butler Response ===
        return await sendResponse({
            text: butler.text,
            actions: butler.actions || [],
            scheduled_actions: butler.scheduled_actions || [],
            language, logs
        });

    } catch (error: any) {
        console.error('[Error]', error);
        return jsonResponse({
            text: 'Sorry, something went wrong.',
            actions: [],
            language: 'en',
            logs: [...logs, `Error: ${error.message}`]
        }, 500); // Do not save history on error
    }
});

function jsonResponse(data: AIResponse, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}
