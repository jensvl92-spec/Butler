/**
 * Butler Agent - Main Orchestrator with Tool Calling
 * 
 * Uses MCP proxy for tool execution and Router for tool selection.
 * 
 * FLOW:
 * 1. Router selects relevant tools from MCP proxy
 * 2. Butler receives ONLY those tools (short prompt)
 * 3. Butler calls tools via MCP proxy as needed
 * 4. Butler returns response + actions
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';
import { selectToolsFromMCP, RouterResult } from './router.ts';

const BUTLER_SYSTEM_PROMPT = `
IDENTITY:
You are a sophisticated smart home butler with full control over the house.

PROCEDURE:
1. ANALYZE the request
2. USE TOOLS to get device information
3. DECIDE what action to take
4. EXECUTE using execute_ha_service
5. RESPOND naturally in the user's language

TOOL USAGE:
- First call get_* or search_* to find devices
- Check current state before acting
- Then call execute_ha_service to control

DELEGATION:
If request needs a specialist agent, DO NOT use tools.
Instead, return:
{
  "delegate_to": "agent_name",
  "text": "Let me handle that for you..."
}

OUTPUT (when done):
{
  "text": "Response to user",
  "actions": [{"entity_id": "...", "service": "...", "data": {...}}]
}
`;

export interface ButlerAction {
    entity_id: string;
    service: string;
    data?: Record<string, any>;
}

export interface ButlerResult {
    text: string;
    actions: ButlerAction[];
    delegate_to?: string | null;
}

interface ToolDefinition {
    name: string;
    description: string;
    when_to_use?: string;
    parameters?: any[];
}

/**
 * Convert MCP tools to OpenAI-style function definitions
 */
function convertToOpenAITools(mcpTools: ToolDefinition[]): any[] {
    return mcpTools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: `${tool.description}${tool.when_to_use ? ` USE WHEN: ${tool.when_to_use}` : ''}`,
            parameters: {
                type: 'object',
                properties: (tool.parameters || []).reduce((acc: any, p: any) => {
                    acc[p.name] = { type: p.type || 'string', description: p.description };
                    return acc;
                }, {}),
                required: (tool.parameters || []).filter((p: any) => p.required).map((p: any) => p.name)
            }
        }
    }));
}

/**
 * Call an MCP tool via the proxy
 */
async function callMCPTool(
    mcpProxyUrl: string,
    toolName: string,
    args: Record<string, any>,
    connectionId: string
): Promise<any> {
    console.log(`[Butler] Calling tool: ${toolName}`, args);

    const response = await fetch(`${mcpProxyUrl}/tools/${toolName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId, args })
    });

    const data = await response.json();
    console.log(`[Butler] Tool result:`, JSON.stringify(data).substring(0, 200));
    return data.result;
}

/**
 * Run the Butler agent with full tool calling support.
 */
export async function runButler(
    message: string,
    mcpProxyUrl: string,
    connectionId: string,
    language: string = 'en'
): Promise<ButlerResult> {
    console.log(`[Butler] Processing: "${message}"`);

    // ============================================
    // STEP 1: Router selects relevant tools
    // ============================================
    console.log('[Butler] Running Router...');
    const { tools: selectedToolNames, agents: selectedAgents, reasoning } =
        await selectToolsFromMCP(message, mcpProxyUrl, connectionId);

    console.log(`[Router] Selected tools: ${selectedToolNames.join(', ')}`);
    console.log(`[Router] Selected agents: ${selectedAgents.join(', ')}`);
    console.log(`[Router] Reasoning: ${reasoning}`);

    // ============================================
    // STEP 2: Check for agent delegation
    // ============================================
    if (selectedAgents.length > 0 && selectedToolNames.length === 0) {
        // Pure delegation - no tools needed
        console.log(`[Butler] Delegating to: ${selectedAgents[0]}`);
        return {
            text: language === 'nl' ? 'Even kijken...' : 'Let me check that for you...',
            actions: [],
            delegate_to: selectedAgents[0]
        };
    }

    // ============================================
    // STEP 3: Fetch full tool definitions
    // ============================================
    const toolsResponse = await fetch(`${mcpProxyUrl}/tools?connection_id=${connectionId}`);
    const { tools: allTools } = await toolsResponse.json();

    // Filter to only selected tools
    const selectedTools = allTools.filter((t: any) => selectedToolNames.includes(t.name));
    const openAITools = convertToOpenAITools(selectedTools);

    console.log(`[Butler] Using ${openAITools.length} tools`);

    // ============================================
    // STEP 4: Butler with tool calling
    // ============================================
    const languageNote = language !== 'en' ? `\n\nIMPORTANT: Respond in ${language}.` : '';

    const messages: any[] = [
        { role: 'system', content: BUTLER_SYSTEM_PROMPT + languageNote },
        { role: 'user', content: message }
    ];

    // Tool calling loop (max 6 iterations)
    for (let turn = 0; turn < 6; turn++) {
        console.log(`[Butler] Turn ${turn + 1}`);

        const response = await chatCompletion(messages, 600, 0.3, openAITools);

        // Handle tool calls
        if (response.tool_calls && response.tool_calls.length > 0) {
            messages.push(response);

            for (const toolCall of response.tool_calls) {
                const toolName = toolCall.function.name;
                const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

                // Execute tool via MCP proxy
                const toolResult = await callMCPTool(mcpProxyUrl, toolName, toolArgs, connectionId);

                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolName,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
                });
            }
            continue;
        }

        // Final response (no more tool calls)
        if (response.content) {
            const result = parseJSONResponse(response.content);

            if (result) {
                console.log(`[Butler] Final result: ${result.text?.substring(0, 100)}...`);
                return {
                    text: result.text || response.content,
                    actions: result.actions || [],
                    delegate_to: result.delegate_to || null
                };
            }

            // Fallback if not JSON
            return {
                text: response.content,
                actions: [],
                delegate_to: null
            };
        }
    }

    // Max turns reached
    console.warn('[Butler] Max turns reached');
    return {
        text: language === 'nl' ? 'Ik kon het niet voltooien.' : 'I couldn\'t complete the request.',
        actions: [],
        delegate_to: null
    };
}
