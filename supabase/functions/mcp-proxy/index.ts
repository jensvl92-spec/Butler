/**
 * MCP Proxy - Supabase Edge Function
 * 
 * Exposes MCP tools and agents for the Butler AI system.
 * 
 * IMPORTANT: Devices come FROM THE APP in each request.
 * The app has WebSocket connection to HA and fetches device states.
 * NO ADD-ON SYNC NEEDED.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// In-memory device cache (per request)
// This stores devices for the current request context
let REQUEST_DEVICES: Map<string, any[]> = new Map();

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const url = new URL(req.url);
    const path = url.pathname.replace('/mcp-proxy', '');

    try {
        // ============================================
        // GET /mcp/catalog - Full catalog in TOON format
        // ============================================
        if (path === '/mcp/catalog' && req.method === 'GET') {
            const connectionId = url.searchParams.get('connection_id');
            console.log(`[Catalog] TOON request for connection_id: ${connectionId}`);

            if (!connectionId) {
                return jsonResponse({ error: 'connection_id required' }, 400);
            }

            // Fetch pre-computed TOON catalogs from mcp_raw_sync
            const { data: syncData, error: syncError } = await supabase
                .from('mcp_raw_sync')
                .select('toon_devices, toon_tools, toon_agents, entity_count, synced_at')
                .eq('connection_id', connectionId)
                .single();

            if (syncError || !syncData) {
                console.warn(`[Catalog] No TOON data for ${connectionId}: ${syncError?.message || 'not found'}`);
                return jsonResponse({
                    toon_devices: 'devices[0]{entity_id,name,domain,room,state}',
                    toon_tools: 'tools[0]{name,domain,description,when_to_use}',
                    toon_agents: 'agents[0]{name,description,when_to_use}',
                    format: 'TOON',
                    synced_at: null,
                    error: 'No sync data found. Please trigger sync from app.'
                });
            }

            console.log(`[Catalog] Serving TOON catalog (synced: ${syncData.synced_at})`);

            return jsonResponse({
                toon_devices: syncData.toon_devices || 'devices[0]{entity_id,name,domain,room,state}',
                toon_tools: syncData.toon_tools || 'tools[0]{name,domain,description,when_to_use}',
                toon_agents: syncData.toon_agents || 'agents[0]{name,description,when_to_use}',
                format: 'TOON',
                synced_at: syncData.synced_at,
                entity_count: syncData.entity_count || 0
            });

        }

        // ============================================
        // GET /tools - List all available tools
        // ============================================
        if (path === '/tools' && req.method === 'GET') {
            const connectionId = url.searchParams.get('connection_id');
            const names = url.searchParams.get('names');

            let query = supabase
                .from('mcp_tools')
                .select('name, type, category, description, when_to_use, parameters, returns, examples');

            if (connectionId) {
                query = query.or(`connection_id.is.null,connection_id.eq.${connectionId}`);
            }

            if (names) {
                const nameList = names.split(',');
                query = query.in('name', nameList);
            }

            const { data: tools } = await query;
            return jsonResponse({ tools: tools || [] });
        }

        // ============================================
        // POST /tools/search - Unified semantic search (tools + devices + rooms)
        // ============================================
        if (path === '/tools/search' && req.method === 'POST') {
            const { query_embedding, limit = 30, connection_id, match_threshold = 0.25, device_states = {} } = await req.json();

            if (!query_embedding) {
                return jsonResponse({ error: 'query_embedding required' }, 400);
            }

            // Using unified mcp_resources search
            const { data: resources, error } = await supabase.rpc('match_mcp_resources', {
                query_embedding: query_embedding,
                match_threshold: match_threshold,
                match_count: limit,
                filter_connection_id: connection_id,
                filter_types: ['tool', 'device', 'room', 'agent']
            });

            if (error) throw error;

            // Group results by type for easy consumption
            const tools = (resources || []).filter((r: any) => r.resource_type === 'tool');

            // Devices: Inject fresh state if available from client
            const devices = (resources || []).filter((r: any) => r.resource_type === 'device').map((d: any) => {
                if (device_states && device_states[d.name]) {
                    // console.log(`[Proxy] Updating state for ${d.name}: ${d.state} -> ${device_states[d.name]}`);
                    d.state = device_states[d.name];
                }
                return d;
            });

            const rooms = (resources || []).filter((r: any) => r.resource_type === 'room');
            const agents = (resources || []).filter((r: any) => r.resource_type === 'agent');

            return jsonResponse({
                tools: tools,
                devices: devices,
                rooms: rooms,
                agents: agents,
                total: resources?.length || 0
            });
        }

        // ============================================
        // GET /agents - List all available agents
        // ============================================
        if (path === '/agents' && req.method === 'GET') {
            const capability = url.searchParams.get('capability');

            let query = supabase
                .from('agents')
                .select('name, type, description, when_to_use, input, output, examples, tags');

            if (capability) {
                query = query.contains('tags', [capability.toLowerCase()]);
            }

            const { data: agents } = await query;
            return jsonResponse({ agents: agents || [] });
        }

        // ============================================
        // GET /climate/heating-rate - Get heating rate for conditions
        // Used by Butler to predict heating time
        // ============================================
        if (path === '/climate/heating-rate' && req.method === 'GET') {
            const connectionId = url.searchParams.get('connection_id');
            const room = url.searchParams.get('room');
            const roomTemp = parseFloat(url.searchParams.get('room_temp') || '18');
            const roomHumidity = parseFloat(url.searchParams.get('room_humidity') || '50');
            const outsideTemp = parseFloat(url.searchParams.get('outside_temp') || '10');
            const outsideHumidity = parseFloat(url.searchParams.get('outside_humidity') || '50');

            if (!connectionId || !room) {
                return jsonResponse({ error: 'connection_id and room required' }, 400);
            }

            // Convert to buckets
            const roomTempBucket = Math.max(10, Math.min(25, Math.round(roomTemp)));
            const roomHumidityBucket = roomHumidity < 40 ? 'low' : roomHumidity < 70 ? 'med' : 'high';
            const outsideTempBucket = Math.floor(Math.max(-20, Math.min(24, outsideTemp)) / 2) * 2;
            const outsideHumidityBucket = outsideHumidity < 40 ? 'low' : outsideHumidity < 70 ? 'med' : 'high';

            // Try exact match first
            let { data: rate } = await supabase
                .from('climate_heating_rates')
                .select('avg_heating_rate, sample_count, last_updated')
                .eq('connection_id', connectionId)
                .eq('room', room)
                .eq('room_temp_bucket', roomTempBucket)
                .eq('room_humidity_bucket', roomHumidityBucket)
                .eq('outside_temp_bucket', outsideTempBucket)
                .eq('outside_humidity_bucket', outsideHumidityBucket)
                .single();

            if (!rate) {
                // Fallback: find closest match (same room, similar conditions)
                const { data: fallback } = await supabase
                    .from('climate_heating_rates')
                    .select('avg_heating_rate, sample_count, room_temp_bucket, outside_temp_bucket')
                    .eq('connection_id', connectionId)
                    .eq('room', room)
                    .order('sample_count', { ascending: false })
                    .limit(5);

                if (fallback && fallback.length > 0) {
                    // Return average of available rates with a note
                    const avgRate = fallback.reduce((sum, r) => sum + r.avg_heating_rate, 0) / fallback.length;
                    return jsonResponse({
                        heating_rate: avgRate,
                        confidence: 'estimated',
                        message: `No exact match. Estimated from ${fallback.length} similar conditions.`,
                        sample_conditions: fallback.slice(0, 3)
                    });
                }

                return jsonResponse({
                    heating_rate: null,
                    confidence: 'none',
                    message: `No heating data for ${room}. Trigger learn-climate or wait for more heating cycles.`
                });
            }

            return jsonResponse({
                heating_rate: rate.avg_heating_rate,
                sample_count: rate.sample_count,
                last_updated: rate.last_updated,
                confidence: rate.sample_count >= 5 ? 'high' : rate.sample_count >= 2 ? 'medium' : 'low',
                conditions: {
                    room_temp_bucket: roomTempBucket,
                    room_humidity_bucket: roomHumidityBucket,
                    outside_temp_bucket: outsideTempBucket,
                    outside_humidity_bucket: outsideHumidityBucket
                }
            });
        }

        // ============================================
        // POST /context - Set device context for this request
        // Called by process-ai-command before Butler runs
        // ============================================
        if (path === '/context' && req.method === 'POST') {
            const { request_id, devices } = await req.json();

            if (!request_id || !devices) {
                return jsonResponse({ error: 'request_id and devices required' }, 400);
            }

            // Store devices in memory for this request
            REQUEST_DEVICES.set(request_id, devices);

            // Clean up old requests (keep last 100)
            if (REQUEST_DEVICES.size > 100) {
                const keys = Array.from(REQUEST_DEVICES.keys());
                for (let i = 0; i < keys.length - 100; i++) {
                    REQUEST_DEVICES.delete(keys[i]);
                }
            }

            return jsonResponse({ success: true, device_count: devices.length });
        }

        // ============================================
        // POST /tools/{name} - Execute a tool
        // Uses devices from context (set via /context)
        // ============================================
        if (path.startsWith('/tools/') && req.method === 'POST') {
            const toolName = path.split('/')[2];
            const body = await req.json();
            const { request_id, connection_id, args = {}, devices: inlineDevices } = body;

            // Get devices:
            // 1. Inline (legacy/current app)
            // 2. Context cache (legacy)
            // 3. Database (TARGET ARCHITECTURE)
            let devices = inlineDevices || REQUEST_DEVICES.get(request_id) || [];

            if (devices.length === 0 && connection_id) {
                // Fetch from device_inventory for lean prompts
                const { data: dbDevices } = await supabase
                    .from('device_inventory')
                    .select('entity_id, state, attributes, friendly_name, room')
                    .eq('connection_id', connection_id);

                if (dbDevices) {
                    devices = dbDevices;
                }
            }

            const result = await executeTool(supabase, toolName, args, connection_id, devices);
            return jsonResponse({ result });
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
                const { data } = await supabase
                    .from('user_memories')
                    .select('text, metadata, created_at')
                    .eq('connection_id', connection_id)
                    .ilike('text', `%${query}%`)
                    .limit(10);

                return jsonResponse({ memories: data || [] });
            }

            return jsonResponse({ error: 'Invalid action' }, 400);
        }

        return jsonResponse({ error: `Unknown endpoint: ${path}` }, 404);

    } catch (error: any) {
        console.error('MCP Proxy Error:', error);
        return jsonResponse({ error: error.message }, 500);
    }
});

// ============================================
// Tool Execution - Works with in-memory devices
// ============================================
async function executeTool(
    supabase: any,
    toolName: string,
    args: Record<string, any>,
    connectionId: string,
    devices: any[]
): Promise<any> {

    switch (toolName) {
        case 'get_lights':
            return filterDevices(devices, 'light', args.room);

        case 'get_switches':
            return filterDevices(devices, 'switch', args.room);

        case 'get_climate':
            return filterDevices(devices, 'climate', args.room);

        case 'get_covers':
            return filterDevices(devices, 'cover', args.room);

        case 'get_automations':
            return filterDevices(devices, 'automation', args.filter);

        case 'search_devices': {
            const query = (args.query || '').toLowerCase();
            // Tokenize query: remove common verbs/stopwords if needed, or just split
            const tokens = query.split(/[\s,]+/).filter((t: string) => t.length > 2 && !['turn', 'check', 'set', 'get', 'what', 'show'].includes(t));

            if (tokens.length === 0) {
                // Fallback: if no significant tokens, try looser match or return empty
                if (query.length > 0) tokens.push(query);
            }

            return devices.filter(d => {
                const name = (d.attributes?.friendly_name || d.entity_id || '').toLowerCase();
                const entityId = d.entity_id.toLowerCase();

                // 1. Direct substring match (if query is e.g. "kitchen")
                if (name.includes(query) || entityId.includes(query)) return true;

                // 2. Token match: If ANY significant token is found (OR logic) - good for broad recall
                // Better: If ALL tokens match? No, "turn on kitchen" -> "kitchen" matches. "turn" skipped.
                return tokens.some((token: string) => name.includes(token) || entityId.includes(token));
            }).slice(0, 20);
        }

        case 'save_memory':
            await supabase.from('user_memories').insert({
                connection_id: connectionId,
                text: args.text
            });
            return `Memory saved: "${args.text}"`;

        case 'search_memory': {
            const { data } = await supabase
                .from('user_memories')
                .select('text')
                .eq('connection_id', connectionId)
                .ilike('text', `%${args.query}%`);
            return data?.map((m: any) => m.text) || [];
        }

        case 'execute_ha_service':
            // Returns action for app to execute via WebSocket
            return {
                action_type: 'ha_service_call',
                entity_id: args.entity_id,
                service: args.service,
                data: args.data || {}
            };

        case 'get_history': {
            // Fetch history from HA REST API
            // Requires ha_url and ha_token to be passed in args
            const { ha_url, ha_token, start_time, end_time, entity_ids, significant_changes_only } = args;

            if (!ha_url || !ha_token) {
                return { error: 'get_history requires ha_url and ha_token in args' };
            }

            const startDate = start_time || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const endDate = end_time || new Date().toISOString();

            let historyUrl = `${ha_url}/api/history/period/${encodeURIComponent(startDate)}?end_time=${encodeURIComponent(endDate)}`;
            if (significant_changes_only) {
                historyUrl += '&significant_changes_only=1';
            }
            if (entity_ids && Array.isArray(entity_ids) && entity_ids.length > 0) {
                historyUrl += `&filter_entity_id=${entity_ids.join(',')}`;
            }

            try {
                const historyResp = await fetch(historyUrl, {
                    headers: {
                        'Authorization': `Bearer ${ha_token}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (!historyResp.ok) {
                    const errorBody = await historyResp.text();
                    console.error(`[get_history] HA API error ${historyResp.status}: ${errorBody}`);
                    console.error(`[get_history] URL was: ${historyUrl}`);
                    return { error: `HA API error: ${historyResp.status} - ${errorBody.substring(0, 200)}` };
                }

                const historyData = await historyResp.json();
                // Return summarized history to avoid huge payloads
                // Each entity returns an array of state changes
                const summary = historyData.map((entityHistory: any[]) => {
                    if (!entityHistory || entityHistory.length === 0) return null;
                    const entityId = entityHistory[0]?.entity_id;
                    const states = entityHistory.map((s: any) => ({ state: s.state, last_changed: s.last_changed }));
                    return { entity_id: entityId, changes: states.length, states: states.slice(0, 50) }; // Limit to 50 changes per entity
                }).filter(Boolean);

                return summary;
            } catch (e: any) {
                return { error: `History fetch failed: ${e.message}` };
            }
        }

        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

/**
 * Filter devices by domain and optional room
 */
function filterDevices(devices: any[], domain: string, room?: string): any[] {
    return devices.filter(d => {
        const entityDomain = d.entity_id?.split('.')[0];
        if (entityDomain !== domain) return false;

        if (room) {
            const name = (d.attributes?.friendly_name || d.entity_id || '').toLowerCase();
            const entityRoom = extractRoom(d);
            if (!name.includes(room.toLowerCase()) && entityRoom !== room.toLowerCase()) {
                return false;
            }
        }

        return true;
    }).map(d => ({
        entity_id: d.entity_id,
        state: d.state,
        friendly_name: d.attributes?.friendly_name,
        room: extractRoom(d),
        attributes: d.attributes
    }));
}

function extractRoom(entity: any): string | null {
    const friendlyName = entity.attributes?.friendly_name || '';
    const entityId = entity.entity_id || '';

    const rooms = ['living', 'bedroom', 'kitchen', 'bathroom', 'office', 'garage', 'basement', 'attic', 'dining', 'hallway'];

    for (const room of rooms) {
        if (friendlyName.toLowerCase().includes(room) || entityId.includes(room)) {
            return room;
        }
    }

    return null;
}

function jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}
