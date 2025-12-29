/**
 * Router Agent - Tool & Agent Selector
 * 
 * Uses a fast LLM (Gemini Flash) to select relevant tools and agents
 * BEFORE passing to the main Butler agent. This keeps Butler's prompt short.
 * 
 * RULES:
 * - Be BROAD - better to include extra tools than miss important ones
 * - NO HARD LIMIT - include as many as needed
 * - Always include execute_ha_service if any device tool is selected
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

const ROUTER_SYSTEM_PROMPT = `
You are a tool selector for a smart home AI butler.

YOUR JOB:
Given a user request and lists of available TOOLS and AGENTS, select ALL that MIGHT be relevant.

RULES:
- Be BROAD - include anything potentially useful
- If unsure, INCLUDE IT (let the smarter AI decide)
- NO HARD LIMIT - include as many as needed
- If selecting any device tool, ALWAYS include "execute_ha_service"
- Consider memory tools if request mentions preferences or past behavior

OUTPUT FORMAT (strict JSON):
{
  "tools": ["tool_name", "tool_name", ...],
  "agents": ["agent_name", ...] or [],
  "reasoning": "brief explanation"
}

EXAMPLES:

User: "Turn on the kitchen lights"
→ {"tools": ["get_lights", "search_devices", "execute_ha_service"], "agents": [], "reasoning": "Light control request"}

User: "What's my next meeting?"  
→ {"tools": [], "agents": ["personal_assistant"], "reasoning": "Calendar query - delegate to personal_assistant"}

User: "It's dark and I'm watching TV"
→ {"tools": ["get_lights", "search_devices", "search_memory", "execute_ha_service"], "agents": [], "reasoning": "Needs lights, might have movie preferences"}

User: "Make the porch light turn on at sunset"
→ {"tools": [], "agents": ["automation_creator"], "reasoning": "Creating new automation"}
`;

export interface RouterResult {
    tools: string[];
    agents: string[];
    reasoning: string;
}

interface MCPTool {
    name: string;
    type: string;
    category?: string;
    description: string;
    when_to_use?: string;
}

interface MCPAgent {
    name: string;
    description: string;
    when_to_use?: string;
    tags?: string[];
}

/**
 * Select relevant tools and agents for a user request.
 * Uses fast LLM (Gemini Flash) for quick, broad selection.
 */
export async function runRouter(
    request: string,
    availableTools: MCPTool[],
    availableAgents: MCPAgent[]
): Promise<RouterResult> {
    console.log(`[Router] Selecting tools for: "${request}"`);

    // Format tools for the LLM
    const toolList = availableTools
        .filter(t => t.type === 'tool')
        .map(t => `• ${t.name}: ${t.description}${t.when_to_use ? ` (Use when: ${t.when_to_use})` : ''}`)
        .join('\n');

    // Format agents for the LLM
    const agentList = availableAgents
        .map(a => `• ${a.name}: ${a.description}${a.when_to_use ? ` (Use when: ${a.when_to_use})` : ''}`)
        .join('\n');

    const response = await chatCompletion([
        { role: 'system', content: ROUTER_SYSTEM_PROMPT },
        { role: 'user', content: `AVAILABLE TOOLS:\n${toolList}\n\nAVAILABLE AGENTS:\n${agentList}\n\nUSER REQUEST: ${request}` }
    ], 200, 0); // Low temperature for consistent selection

    const result = parseJSONResponse(response);

    if (!result) {
        console.warn('[Router] Failed to parse response, using fallback');
        // Fallback: include common tools
        return {
            tools: ['search_devices', 'execute_ha_service'],
            agents: [],
            reasoning: 'Fallback selection due to parse error'
        };
    }

    console.log(`[Router] Selected: ${result.tools?.length || 0} tools, ${result.agents?.length || 0} agents`);
    return result as RouterResult;
}

/**
 * Fetch tools and agents from MCP proxy, then select relevant ones.
 */
export async function selectToolsFromMCP(
    request: string,
    mcpProxyUrl: string,
    connectionId: string
): Promise<RouterResult> {
    // Fetch available tools
    const toolsResponse = await fetch(`${mcpProxyUrl}/tools?connection_id=${connectionId}`);
    const { tools } = await toolsResponse.json();

    // Fetch available agents
    const agentsResponse = await fetch(`${mcpProxyUrl}/agents`);
    const { agents } = await agentsResponse.json();

    // Run router to select relevant ones
    return runRouter(request, tools || [], agents || []);
}
