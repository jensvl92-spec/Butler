/**
 * MCP Proxy - Supabase Edge Function
 * 
 * Exposes MCP tools and agents for the Butler AI system.
 * Tools are stored in database, synced from Home Assistant.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

serve(async (req: Request) => {
    // Handle CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const url = new URL(req.url);
    const path = url.pathname.replace('/mcp-proxy', '');

    try {
        // ============================================
        // GET /tools - List all available tools
        // ============================================
        if (path === '/tools' && req.method === 'GET') {
            const connectionId = url.searchParams.get('connection_id');

            // Get global tools + connection-specific tools
            let query = supabase
                .from('mcp_tools')
                .select('name, type, category, description, when_to_use, parameters, returns, examples');

            if (connectionId) {
                query = query.or(`connection_id.is.null,connection_id.eq.${connectionId}`);
            } else {
                query = query.is('connection_id', null);
            }

            const { data: tools, error } = await query;

            if (error) throw error;

            return jsonResponse({ tools: tools || [] });
        }

        // ============================================
        // GET /agents - List all available agents
        // ============================================
        if (path === '/agents' && req.method === 'GET') {
            const capability = url.searchParams.get('capability');

            let query = supabase
                .from('agents')
                .select('name, type, description, when_to_use, input, output, examples, tags');

            // Filter by capability if provided
            if (capability) {
                query = query.contains('tags', [capability.toLowerCase()]);
            }

            const { data: agents, error } = await query;

            if (error) throw error;

            return jsonResponse({ agents: agents || [] });
        }

        // ============================================
        // POST /tools/{name} - Execute a tool
        // ============================================
        if (path.startsWith('/tools/') && req.method === 'POST') {
            const toolName = path.split('/')[2];
            const body = await req.json();
            const { connection_id, args = {} } = body;

            if (!connection_id) {
                return jsonResponse({ error: 'connection_id required' }, 400);
            }

            const result = await executeTool(supabase, toolName, args, connection_id);
            return jsonResponse({ result });
        }

        // ============================================
        // POST /search - Semantic device search
        // ============================================
        if (path === '/search' && req.method === 'POST') {
            const { connection_id, query } = await req.json();

            if (!connection_id || !query) {
                return jsonResponse({ error: 'connection_id and query required' }, 400);
            }

            // Simple text search (could be enhanced with embeddings)
            const { data, error } = await supabase
                .from('device_inventory')
                .select('entity_id, domain, state, friendly_name, room, attributes')
                .eq('connection_id', connection_id)
                .or(`friendly_name.ilike.%${query}%,entity_id.ilike.%${query}%,room.ilike.%${query}%`)
                .limit(20);

            if (error) throw error;

            return jsonResponse({ results: data || [] });
        }

        // ============================================
        // POST /memory - Save or search memories
        // ============================================
        if (path === '/memory' && req.method === 'POST') {
            const { connection_id, action, text, query } = await req.json();

            if (!connection_id) {
                return jsonResponse({ error: 'connection_id required' }, 400);
            }

            if (action === 'save') {
                const { error } = await supabase
                    .from('user_memories')
                    .insert({ connection_id, text });

                if (error) throw error;
                return jsonResponse({ success: true, message: `Memory saved: "${text}"` });
            }

            if (action === 'search') {
                const { data, error } = await supabase
                    .from('user_memories')
                    .select('text, metadata, created_at')
                    .eq('connection_id', connection_id)
                    .ilike('text', `%${query}%`)
                    .limit(10);

                if (error) throw error;
                return jsonResponse({ memories: data || [] });
            }

            return jsonResponse({ error: 'Invalid action. Use "save" or "search"' }, 400);
        }

        // ============================================
        // POST /sync - Sync devices from HA add-on
        // ============================================
        if (path === '/sync' && req.method === 'POST') {
            const { connection_id, entities } = await req.json();

            if (!connection_id || !entities) {
                return jsonResponse({ error: 'connection_id and entities required' }, 400);
            }

            // Delete old entries for this connection
            await supabase
                .from('device_inventory')
                .delete()
                .eq('connection_id', connection_id);

            // Insert new entries
            const rows = entities.map((e: any) => ({
                connection_id,
                entity_id: e.entity_id,
                domain: e.entity_id.split('.')[0],
                state: e.state,
                friendly_name: e.attributes?.friendly_name || null,
                room: extractRoom(e),
                attributes: e.attributes || {},
            }));

            const { error } = await supabase
                .from('device_inventory')
                .insert(rows);

            if (error) throw error;

            return jsonResponse({
                success: true,
                message: `Synced ${rows.length} entities`,
                count: rows.length
            });
        }

        // 404 for unknown paths
        return jsonResponse({ error: `Unknown endpoint: ${path}` }, 404);

    } catch (error: any) {
        console.error('MCP Proxy Error:', error);
        return jsonResponse({ error: error.message }, 500);
    }
});

// ============================================
// Tool Execution
// ============================================
async function executeTool(
    supabase: any,
    toolName: string,
    args: Record<string, any>,
    connectionId: string
): Promise<any> {

    switch (toolName) {
        case 'get_lights':
            return getDevicesByDomain(supabase, connectionId, 'light', args.room);

        case 'get_switches':
            return getDevicesByDomain(supabase, connectionId, 'switch', args.room);

        case 'get_climate':
            return getDevicesByDomain(supabase, connectionId, 'climate', args.room);

        case 'get_covers':
            return getDevicesByDomain(supabase, connectionId, 'cover', args.room);

        case 'search_devices':
            return searchDevices(supabase, connectionId, args.query);

        case 'get_automations':
            return getDevicesByDomain(supabase, connectionId, 'automation', args.filter);

        case 'save_memory':
            await supabase.from('user_memories').insert({
                connection_id: connectionId,
                text: args.text
            });
            return `Memory saved: "${args.text}"`;

        case 'search_memory':
            const { data: memories } = await supabase
                .from('user_memories')
                .select('text')
                .eq('connection_id', connectionId)
                .ilike('text', `%${args.query}%`);
            return memories?.map((m: any) => m.text) || [];

        case 'execute_ha_service':
            // This returns the action for the app to execute via WebSocket
            // The actual execution happens on the client side
            return {
                action_type: 'ha_service_call',
                entity_id: args.entity_id,
                service: args.service,
                data: args.data || {}
            };

        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

async function getDevicesByDomain(
    supabase: any,
    connectionId: string,
    domain: string,
    roomFilter?: string
): Promise<any[]> {
    let query = supabase
        .from('device_inventory')
        .select('entity_id, state, friendly_name, room, attributes')
        .eq('connection_id', connectionId)
        .eq('domain', domain);

    if (roomFilter) {
        query = query.ilike('room', `%${roomFilter}%`);
    }

    const { data } = await query;
    return data || [];
}

async function searchDevices(
    supabase: any,
    connectionId: string,
    query: string
): Promise<any[]> {
    const { data } = await supabase
        .from('device_inventory')
        .select('entity_id, domain, state, friendly_name, room')
        .eq('connection_id', connectionId)
        .or(`friendly_name.ilike.%${query}%,entity_id.ilike.%${query}%`)
        .limit(20);

    return data || [];
}

function extractRoom(entity: any): string | null {
    // Try to extract room from friendly_name or entity_id
    const friendlyName = entity.attributes?.friendly_name || '';
    const entityId = entity.entity_id || '';

    // Common room patterns
    const rooms = ['living', 'bedroom', 'kitchen', 'bathroom', 'office', 'garage', 'basement', 'attic'];

    for (const room of rooms) {
        if (friendlyName.toLowerCase().includes(room) || entityId.includes(room)) {
            return room;
        }
    }

    return null;
}

function jsonResponse(data: any, status: number = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}
