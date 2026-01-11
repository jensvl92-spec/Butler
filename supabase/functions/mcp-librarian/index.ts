/**
 * MCP Librarian - Supabase Edge Function
 * 
 * Builds and maintains a professional Custom MCP Server.
 * Uses AI to format raw HA data with maximum clarity.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { chatCompletion, parseJSONResponse, createEmbedding } from "../_shared/llm-service.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LLM_API_KEY = Deno.env.get('OPENROUTER_API_KEY') || Deno.env.get('LLM_API_KEY');

// ============================================
// TOON (Token-Oriented Object Notation) Helper
// Converts arrays of objects to compact tabular format
// ============================================
function toTOON(items: any[], name: string, fields: string[]): string {
    if (!items || items.length === 0) {
        return `${name}[0]{${fields.join(',')}}`;
    }
    const header = `${name}[${items.length}]{${fields.join(',')}}`;
    const rows = items.map(item =>
        fields.map(f => {
            const val = item[f];
            // Handle null/undefined, convert to string, escape tabs/newlines
            return val == null ? '' : String(val).replace(/\t/g, ' ').replace(/\n/g, ' ');
        }).join('\t')
    );
    return [header, ...rows].join('\n');
}

// Librarian prompt for formatting tools
const LIBRARIAN_PROMPT = `
You are the MCP Librarian - a specialist in building professional tool databases for AI assistants.

## YOUR TASK
Convert raw Home Assistant service/entity data into a properly formatted MCP tool entry.

## OUTPUT FORMAT (JSON)
{
  "name": "domain.service_name",
  "category": "category.subcategory",
  "description": "ONE clear sentence describing what this tool does.",
  "when_to_use": "Keywords and phrases that should trigger this tool.",
  "parameters": [
    {
      "name": "param_name",
      "type": "string|number|boolean|object",
      "required": true|false,
      "description": "What this parameter does"
    }
  ],
  "returns": "What the tool returns",
  "examples": [
    "Example usage with common parameters"
  ]
}

## CATEGORIES
- devices.lights - Light control (turn on, off, brightness, color)
- devices.switches - Switches, plugs, outlets
- devices.climate - Thermostats, AC, heaters
- devices.covers - Blinds, curtains, garage doors
- devices.media - Media players, TV, speakers
- devices.locks - Door locks, smart locks
- devices.fans - Fans, ventilation
- devices.sensors - Sensors (read-only)
- automation.control - Enable/disable/trigger automations
- automation.scenes - Activate scenes
- system.scripts - Run scripts
- memory.preferences - User preferences
- agents.delegation - Delegate to specialist agents

## RULES
1. description: ONE clear sentence, no jargon
2. when_to_use: Include synonyms, slang, and common phrases
3. parameters: Extract from service schema, include defaults if known
4. examples: 2-3 practical examples showing common use cases
5. Be SPECIFIC about what the tool does
`;

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const url = new URL(req.url);
    const path = url.pathname.replace('/mcp-librarian', '');

    try {
        if (path === '/sync-states' && req.method === 'POST') {
            const { connection_id, states } = await req.json();

            if (!connection_id) return jsonResponse({ error: 'connection_id required' }, 400);
            if (!states || !Array.isArray(states)) return jsonResponse({ error: 'states array required' }, 400);

            console.log(`[Librarian] State sync for ${connection_id}: ${states.length} updates`);

            // Batch upsert to device_states
            const { error } = await supabase
                .from('device_states')
                .upsert(states.map((s: any) => ({
                    connection_id,
                    entity_id: s.entity_id,
                    state: s.state,
                    attributes: s.attributes || {},
                    last_updated: new Date().toISOString()
                })), { onConflict: 'connection_id, entity_id' });

            if (error) {
                console.error('[Librarian] State upsert failed:', error);
                return jsonResponse({ error: error.message }, 500);
            }

            return jsonResponse({ success: true, count: states.length });
        }

        // ============================================
        // POST /sync - Process raw HA data (Definitions)
        // Supports sync_mode: "start" | "append" | "complete"
        // ============================================
        if (path === '/sync' && req.method === 'POST') {
            const { connection_id, entities, services, sync_mode = 'replace' } = await req.json();

            if (!connection_id) {
                return jsonResponse({ error: 'connection_id required' }, 400);
            }

            console.log(`[Librarian] Sync (mode: ${sync_mode}) for ${connection_id}: ${entities?.length || 0} entities, ${services ? Object.keys(services).length : 0} service domains`);

            // ============================================
            // ACCUMULATION LOGIC based on sync_mode
            // ============================================
            let existingDevices: any[] = [];
            let existingTools: any[] = [];

            if (sync_mode === 'start') {
                // CLEAN SLATE - Delete old JSON data
                console.log(`[Librarian] START mode - Cleaning old data for ${connection_id}...`);

                await supabase.from('mcp_resources').delete().eq('connection_id', connection_id);
                await supabase.from('mcp_tools').delete().eq('connection_id', connection_id);
                await supabase.from('mcp_raw_sync').delete().eq('connection_id', connection_id);

                console.log(`[Librarian] Old data cleaned. Starting fresh...`);

            } else if (sync_mode === 'append' || sync_mode === 'complete') {
                // FETCH EXISTING data to merge
                console.log(`[Librarian] ${sync_mode.toUpperCase()} mode - Fetching existing data...`);

                const { data: existing } = await supabase
                    .from('mcp_raw_sync')
                    .select('toon_devices, toon_tools, accumulated_devices, accumulated_tools')
                    .eq('connection_id', connection_id)
                    .single();

                if (existing) {
                    existingDevices = existing.accumulated_devices || [];
                    existingTools = existing.accumulated_tools || [];
                    console.log(`[Librarian] Loaded existing: ${existingDevices.length} devices, ${existingTools.length} tools`);
                }
            }
            // For 'replace' mode (default/legacy), don't load existing - just overwrite

            // ============================================
            // STEP 1: Build Device Data from this batch
            // ============================================
            const newDevices = (entities || []).map((e: any) => ({
                entity_id: e.entity_id,
                name: e.attributes?.friendly_name || e.entity_id,
                domain: e.entity_id.split('.')[0],
                room: extractRoom(e) || '',
                state: e.state || 'unknown'
            }));

            // Merge with existing (deduplicate by entity_id)
            const deviceMap = new Map();
            for (const d of existingDevices) deviceMap.set(d.entity_id, d);
            for (const d of newDevices) deviceMap.set(d.entity_id, d);
            const allDevices = Array.from(deviceMap.values());

            console.log(`[Librarian] Devices: ${newDevices.length} new + ${existingDevices.length} existing = ${allDevices.length} total`);

            // ============================================
            // STEP 2: Build Tools from this batch (with LLM)
            // ============================================
            const domains = new Set<string>();
            for (const entity of entities || []) {
                const domain = entity.entity_id?.split('.')[0];
                if (domain) domains.add(domain);
            }

            const servicesToFormat: any[] = [];
            if (services) {
                for (const [domain, domainServices] of Object.entries(services)) {
                    if (!domains.has(domain)) continue;
                    for (const [serviceName, serviceInfo] of Object.entries(domainServices as any)) {
                        servicesToFormat.push({
                            name: `${domain}.${serviceName}`,
                            domain,
                            service: serviceName,
                            info: serviceInfo
                        });
                    }
                }
            }

            console.log(`[Librarian] ${servicesToFormat.length} services to format with LLM...`);

            // Format tools with LLM (batch to avoid rate limits)
            const newTools: any[] = [];
            const BATCH_SIZE = 20;

            for (let i = 0; i < Math.min(servicesToFormat.length, 100); i += BATCH_SIZE) {
                const batch = servicesToFormat.slice(i, i + BATCH_SIZE);
                const batchPromises = batch.map(svc => formatWithLibrarian(svc));
                const results = await Promise.all(batchPromises);

                for (const formatted of results) {
                    if (formatted && formatted.name) {
                        newTools.push({
                            name: formatted.name,
                            category: formatted.category || 'devices.other',
                            description: formatted.description || '',
                            when_to_use: formatted.when_to_use || ''
                        });
                    }
                }
            }

            // Merge with existing (deduplicate by name)
            const toolMap = new Map();
            for (const t of existingTools) toolMap.set(t.name, t);
            for (const t of newTools) toolMap.set(t.name, t);
            const allTools = Array.from(toolMap.values());

            console.log(`[Librarian] Tools: ${newTools.length} new + ${existingTools.length} existing = ${allTools.length} total`);

            // ============================================
            // STEP 3: Build TOON catalogs
            // ============================================
            const toonDevices = toTOON(allDevices, 'devices',
                ['entity_id', 'name', 'domain', 'room', 'state']);

            const toonTools = toTOON(allTools, 'tools',
                ['name', 'category', 'description', 'when_to_use']);

            // Agents (only fetch on complete or replace)
            let toonAgents = 'agents[0]{name,description,when_to_use}';
            if (sync_mode === 'complete' || sync_mode === 'replace') {
                const { data: agents } = await supabase
                    .from('agents')
                    .select('name, description, when_to_use');
                toonAgents = toTOON(agents || [], 'agents', ['name', 'description', 'when_to_use']);
            }

            // ============================================
            // STEP 4: Store in mcp_raw_sync
            // ============================================
            const { error: syncError } = await supabase
                .from('mcp_raw_sync')
                .upsert({
                    connection_id,
                    entity_count: allDevices.length,
                    service_domains: services ? Object.keys(services) : [],
                    toon_devices: toonDevices,
                    toon_tools: toonTools,
                    toon_agents: toonAgents,
                    accumulated_devices: allDevices,
                    accumulated_tools: allTools,
                    synced_at: new Date().toISOString()
                }, { onConflict: 'connection_id' });

            if (syncError) {
                console.error(`[Librarian] TOON sync error:`, syncError);
                return jsonResponse({ error: 'Failed to store TOON catalog: ' + syncError.message }, 500);
            }

            console.log(`[Librarian] Sync ${sync_mode} complete! Total: ${allDevices.length} devices, ${allTools.length} tools`);

            return jsonResponse({
                success: true,
                format: 'TOON',
                sync_mode,
                devices: allDevices.length,
                tools: allTools.length,
                new_devices: newDevices.length,
                new_tools: newTools.length
            });
        }

        // ============================================
        // POST /format - Format a single tool (for testing)
        // ============================================
        if (path === '/format' && req.method === 'POST') {
            const { service } = await req.json();
            const formatted = await formatWithLibrarian(service);
            return jsonResponse({ formatted });
        }

        // ============================================
        // GET /tools - Get formatted tools
        // ============================================
        if (path === '/tools' && req.method === 'GET') {
            const connectionId = url.searchParams.get('connection_id');

            let query = supabase
                .from('mcp_tools')
                .select('*')
                .order('category');

            if (connectionId) {
                query = query.or(`connection_id.is.null,connection_id.eq.${connectionId}`);
            }

            const { data } = await query;
            return jsonResponse({ tools: data || [] });
        }

        return jsonResponse({ error: 'Unknown endpoint' }, 404);

    } catch (error: any) {
        console.error('[Librarian Error]', error);
        return jsonResponse({ error: error.message }, 500);
    }
});

/**
 * Format a raw HA service using the Librarian LLM
 */
async function formatWithLibrarian(service: any): Promise<any> {
    const prompt = `RAW SERVICE DATA:\n${JSON.stringify(service, null, 2)}`;

    try {
        const response = await chatCompletion([
            { role: 'system', content: LIBRARIAN_PROMPT },
            { role: 'user', content: prompt }
        ], 1000, 0.1);

        return parseJSONResponse(response) || basicFormat(service);
    } catch (error) {
        console.error('[Librarian] LLM Error:', error);
        return basicFormat(service);
    }
}

/**
 * Basic format fallback (no LLM)
 */
function basicFormat(service: any): any {
    const categoryMap: Record<string, string> = {
        light: 'devices.lights',
        switch: 'devices.switches',
        climate: 'devices.climate',
        cover: 'devices.covers',
        media_player: 'devices.media',
        lock: 'devices.locks',
        fan: 'devices.fans',
        automation: 'automation.control',
        scene: 'automation.scenes',
        script: 'system.scripts'
    };

    return {
        name: service.name,
        category: categoryMap[service.domain] || 'system.other',
        description: service.info?.description || `${service.domain} ${service.service}`,
        when_to_use: `User wants to ${service.service.replace(/_/g, ' ')} a ${service.domain}`,
        parameters: Object.entries(service.info?.fields || {}).map(([name, info]: [string, any]) => ({
            name,
            type: 'string',
            required: info.required || false,
            description: info.description || name
        })),
        returns: 'Confirmation of action',
        examples: [`${service.name}(entity_id='${service.domain}.example')`]
    };
}

function jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

function extractRoom(entity: any): string | null {
    const friendlyName = (entity.attributes?.friendly_name || '').toLowerCase();
    const entityId = (entity.entity_id || '').toLowerCase();

    // Common room names (multi-lingual support could be added here)
    const rooms = ['living', 'bedroom', 'kitchen', 'bathroom', 'office', 'garage', 'basement', 'attic', 'dining', 'hallway', 'garden', 'patio',
        'woonkamer', 'slaapkamer', 'keuken', 'badkamer', 'kantoor', 'garage', 'kelder', 'zolder', 'eetkamer', 'gang', 'tuin'];

    for (const room of rooms) {
        if (friendlyName.includes(room) || entityId.includes(room)) {
            // Normalize Dutch to English for consistency if desired, or keep native. 
            // For now keeping native/mixed as it aids matching user queries.
            return room;
        }
    }
    return null;
}
