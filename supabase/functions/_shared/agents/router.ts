/**
 * Router Agent - Tool & Device Selector (LLM-Native)
 * 
 * Uses Gemini Flash to select relevant tools and devices from full MCP catalog.
 * NO embeddings, NO vector search - just fast, multilingual LLM selection.
 */

import { groqMainCompletion, parseJSONResponse } from '../llm-service.ts';

const ROUTER_SYSTEM_PROMPT = `You select relevant tools, devices, AND AGENTS for a smart home butler.

INPUT FORMAT: TOON (Token-Oriented Object Notation)
- Header line: name[count]{field1,field2,...}
- Data rows: tab-separated values (\t between fields)
- Read the header to understand which column is which
- Example: devices[2]{entity_id,name,domain,room,state}
           light.kitchen\tKitchen Light\tlight\tkitchen\ton

Given a user request in ANY LANGUAGE, select:
1. TOOLS the butler might need (ALL actions that could be relevant)
2. DEVICES that match the request (ALL matching CONTROLLABLE entities)
3. AGENTS that specialize in the request (e.g., Analyzer for suggestions/proposals)

CRITICAL RULES:
- OVER-INCLUDE both tools AND devices! It's MUCH better to return too many than to miss one.
- When a ROOM is mentioned: return ALL controllable devices in that room
- When a DEVICE TYPE is mentioned: return ALL devices of that type
- For ANY light/switch command: include BOTH light.* AND switch.* domains
- Understand ALL languages (Dutch "keuken" = English "kitchen")
- Return entity_ids from the FIRST COLUMN of the devices catalog

ENTITY FILTERING (CRITICAL):
For control commands (turn on, turn off, toggle, set):
- INCLUDE: light.*, switch.*, cover.*, climate.*, lock.*, fan.*, media_player.*
- EXCLUDE: sensor.*, binary_sensor.*, update.*, button.*, number.*, input_*, automation.*
- Sensors CANNOT be turned on/off - they are read-only!

AGENT SELECTION:
- If user asks for "suggestions", "proposals", "ideas", "analyze my history": SELECT THE ANALYZER AGENT.
- **NEVER** select Analyzer for control commands (turn on, turn off, set, toggle), even if they include delays or time expressions like "in X minutes", "over X minuten", "then wait".
- Otherwise, leave agents empty.

OUTPUT (strict JSON):
{
  "tools": ["tool.name", ...],
  "devices": ["entity_id", ...],
  "agents": ["agent name", ...],
  "reasoning": "brief explanation"
}
`;

export interface RouterResult {
    tools: string[];
    devices: string[];
    agents?: string[];
    reasoning: string;
}

/**
 * Select relevant tools and devices using LLM (no embeddings)
 */
export async function selectToolsFromMCP(
    request: string,
    mcpProxyUrl: string,
    connectionId: string
): Promise<RouterResult> {
    console.log(`[Router] LLM selection for: "${request}"`);

    try {
        // 1. Fetch full catalog from MCP
        const catalogUrl = `${mcpProxyUrl}/mcp/catalog?connection_id=${connectionId}`;
        console.log(`[Router] Fetching: ${catalogUrl}`);

        // Supabase function-to-function calls need both apikey and Authorization
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
        const catalogResponse = await fetch(catalogUrl, {
            headers: {
                "apikey": anonKey || serviceKey || "",
                "Authorization": `Bearer ${serviceKey}`
            }
        });

        if (!catalogResponse.ok) {
            console.error(`[Router] Catalog fetch failed: ${catalogResponse.status}`);
            return {
                tools: [],
                devices: [],
                reasoning: `DIAG: Catalog fetch failed with status ${catalogResponse.status}`
            };
        }

        const catalog = await catalogResponse.json();

        // TOON format: pre-computed strings from mcp_raw_sync
        const toonDevices = catalog.toon_devices || 'devices[0]{entity_id,name,domain,room,state}';
        const toonTools = catalog.toon_tools || 'tools[0]{name,domain,description,when_to_use}';
        const toonAgents = catalog.toon_agents || 'agents[0]{name,description,when_to_use}';

        // Extract counts from TOON headers (e.g., "devices[50]{...}" → 50)
        const extractCount = (toon: string) => {
            const match = toon.match(/\[(\d+)\]/);
            return match ? parseInt(match[1], 10) : 0;
        };

        const deviceCount = extractCount(toonDevices);
        const toolCount = extractCount(toonTools);
        const agentCount = extractCount(toonAgents);

        console.log(`[Router] TOON Catalog: ${toolCount} tools, ${deviceCount} devices, ${agentCount} agents`);

        // If catalog is empty, return diagnostic info
        if (toolCount === 0 && deviceCount === 0 && agentCount === 0) {
            return {
                tools: [],
                devices: [],
                reasoning: `DIAG: Catalog empty. Check if sync was successful.`
            };
        }

        // 2. Build prompt with TOON catalogs (no conversion needed!)
        const userPrompt = `AVAILABLE TOOLS (TOON format):
${toonTools}

AVAILABLE DEVICES (TOON format):
${toonDevices}

AVAILABLE AGENTS (TOON format):
${toonAgents}

USER REQUEST: ${request}`;

        // Use Groq for fast router selection
        const response = await groqMainCompletion([
            { role: 'system', content: ROUTER_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ], 1000, 0);
        const result = parseJSONResponse(response);

        if (!result) {
            console.warn('[Router] Failed to parse response');
            return {
                tools: ['light.turn_on', 'light.turn_off'],
                devices: [],
                reasoning: `DIAG: LLM parse failed. Raw: ${response.substring(0, 100)}`
            };
        }

        console.log(`[Router] Selected: ${result.tools?.length || 0} tools, ${result.devices?.length || 0} devices, ${result.agents?.length || 0} agents`);

        // Ensure reasoning is always present
        return {
            tools: result.tools || [],
            devices: result.devices || [],
            agents: result.agents || [],
            reasoning: result.reasoning || `Selected ${result.tools?.length || 0} tools`
        };

    } catch (e: any) {
        console.error(`[Router] Exception: ${e.message}`);
        return {
            tools: [],
            devices: [],
            reasoning: `DIAG: Router exception: ${e.message}`
        };
    }
}
