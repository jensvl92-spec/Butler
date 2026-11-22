/**
 * MCP Proxy - Supabase Edge Function
 * Authenticated & tenant-scoped proxy for MCP catalog, tools, memory, and HA history (SSRF-safe).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRequestAuth, verifyConnectionOwnership, isSafeExternalUrl, CORS_HEADERS } from "../_shared/auth.ts";
import { fetchWithTimeout } from "../_shared/model-registry.ts";

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const REQUEST_DEVICES: Map<string, any[]> = new Map();

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: CORS_HEADERS });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/mcp-proxy/, '') || '/';

    try {
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) {
            return jsonResponse({ error: auth.error }, auth.status || 401);
        }

        // ============================================
        // GET /mcp/catalog - Full catalog in TOON format
        // ============================================
        if (path === '/mcp/catalog' && req.method === 'GET') {
            const connectionId = url.searchParams.get('connection_id');
            if (!connectionId) return jsonResponse({ error: 'connection_id required' }, 400);

            const ownership = await verifyConnectionOwnership(supabase, auth, connectionId);
            if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);

            const { data: syncData, error: syncError } = await supabase
                .from('mcp_raw_sync')
                .select('toon_devices, toon_tools, toon_agents, entity_count, synced_at')
                .eq('connection_id', connectionId)
                .maybeSingle();

            if (syncError || !syncData) {
                return jsonResponse({
                    toon_devices: 'devices[0]{entity_id,name,domain,room,state}',
                    toon_tools: 'tools[0]{name,domain,description,when_to_use}',
                    toon_agents: 'agents[0]{name,description,when_to_use}',
                    format: 'TOON',
                    synced_at: null,
                    error: 'No sync data found. Please trigger sync from app.'
                });
            }

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

            if (connectionId) {
                const ownership = await verifyConnectionOwnership(supabase, auth, connectionId);
                if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);
            }

            let query = supabase
                .from('mcp_tools')
                .select('name, type, category, description, when_to_use, parameters, returns, examples');

            if (connectionId) {
                query = query.or(`connection_id.is.null,connection_id.eq.${connectionId}`);
            } else {
                query = query.is('connection_id', null);
            }

            if (names) {
                query = query.in('name', names.split(','));
            }

            const { data: tools } = await query;
            return jsonResponse({ tools: tools || [] });
        }

        // ============================================
        // POST /tools/search - Unified semantic search
        // ============================================
        if (path === '/tools/search' && req.method === 'POST') {
            const { query_embedding, limit = 30, connection_id, match_threshold = 0.25, device_states = {} } = await req.json();

            if (!query_embedding) return jsonResponse({ error: 'query_embedding required' }, 400);
            if (connection_id) {
                const ownership = await verifyConnectionOwnership(supabase, auth, connection_id);
                if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);
            }

            const { data: resources, error } = await supabase.rpc('match_mcp_resources', {
                query_embedding,
                match_threshold,
                match_count: limit,
                filter_connection_id: connection_id,
                filter_types: ['tool', 'device', 'room', 'agent']
            });

            if (error) throw error;

            const tools = (resources || []).filter((r: any) => r.resource_type === 'tool');
            const devices = (resources || []).filter((r: any) => r.resource_type === 'device').map((d: any) => {
                if (device_states && device_states[d.name]) d.state = device_states[d.name];
                return d;
            });
            const rooms = (resources || []).filter((r: any) => r.resource_type === 'room');
            const agents = (resources || []).filter((r: any) => r.resource_type === 'agent');

            return jsonResponse({ tools, devices, rooms, agents, total: resources?.length || 0 });
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
        // GET /climate/heating-rate
        // ============================================
        if (path === '/climate/heating-rate' && req.method === 'GET') {
            const connectionId = url.searchParams.get('connection_id');
            const room = url.searchParams.get('room');
            const roomTemp = parseFloat(url.searchParams.get('room_temp') || '18');
            const roomHumidity = parseFloat(url.searchParams.get('room_humidity') || '50');
            const outsideTemp = parseFloat(url.searchParams.get('outside_temp') || '10');
            const outsideHumidity = parseFloat(url.searchParams.get('outside_humidity') || '50');

            if (!connectionId || !room) return jsonResponse({ error: 'connection_id and room required' }, 400);

            const ownership = await verifyConnectionOwnership(supabase, auth, connectionId);
            if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);

            const roomTempBucket = Math.max(10, Math.min(25, Math.round(roomTemp)));
            const roomHumidityBucket = roomHumidity < 40 ? 'low' : roomHumidity < 70 ? 'med' : 'high';
            const outsideTempBucket = Math.floor(Math.max(-20, Math.min(24, outsideTemp)) / 2) * 2;
            const outsideHumidityBucket = outsideHumidity < 40 ? 'low' : outsideHumidity < 70 ? 'med' : 'high';

            const { data: rate } = await supabase
                .from('climate_heating_rates')
                .select('avg_heating_rate, sample_count, last_updated')
                .eq('connection_id', connectionId)
                .eq('room', room)
                .eq('room_temp_bucket', roomTempBucket)
                .eq('room_humidity_bucket', roomHumidityBucket)
                .eq('outside_temp_bucket', outsideTempBucket)
                .eq('outside_humidity_bucket', outsideHumidityBucket)
                .maybeSingle();

            if (!rate) {
                const { data: fallback } = await supabase
                    .from('climate_heating_rates')
                    .select('avg_heating_rate, sample_count, room_temp_bucket, outside_temp_bucket')
                    .eq('connection_id', connectionId)
                    .eq('room', room)
                    .order('sample_count', { ascending: false })
                    .limit(5);

                if (fallback && fallback.length > 0) {
                    const avgRate = fallback.reduce((sum: number, r: any) => sum + r.avg_heating_rate, 0) / fallback.length;
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
                    message: `No heating data for ${room}.`
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
        // POST /context - Set device context for request
        // ============================================
        if (path === '/context' && req.method === 'POST') {
            const { request_id, devices } = await req.json();
            if (!request_id || !devices) return jsonResponse({ error: 'request_id and devices required' }, 400);

            REQUEST_DEVICES.set(request_id, devices);
            if (REQUEST_DEVICES.size > 100) {
                const keys = Array.from(REQUEST_DEVICES.keys());
                for (let i = 0; i < keys.length - 100; i++) REQUEST_DEVICES.delete(keys[i]);
            }
            return jsonResponse({ success: true, device_count: devices.length });
        }

        // ============================================
        // POST /tools/{name} - Execute a tool
        // ============================================
        if (path.startsWith('/tools/') && req.method === 'POST') {
            const toolName = path.split('/')[2];
            const body = await req.json();
            const { request_id, connection_id, args = {}, devices: inlineDevices } = body;

            let verifiedConn: any = null;
            if (connection_id) {
                const ownership = await verifyConnectionOwnership(supabase, auth, connection_id);
                if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);
                verifiedConn = ownership.connection;
            }

            let devices = inlineDevices || REQUEST_DEVICES.get(request_id) || [];
            if (devices.length === 0 && connection_id) {
                const { data: dbDevices } = await supabase
                    .from('device_inventory')
                    .select('entity_id, state, attributes, friendly_name, room')
                    .eq('connection_id', connection_id);
                if (dbDevices) devices = dbDevices;
            }

            const result = await executeTool(supabase, toolName, args, connection_id, devices, verifiedConn);
            return jsonResponse({ result });
        }

        // ============================================
        // POST /memory - Save or search memories
        // ============================================
        if (path === '/memory' && req.method === 'POST') {
            const { connection_id, action, text, query } = await req.json();
            if (!connection_id) return jsonResponse({ error: 'connection_id required' }, 400);

            const ownership = await verifyConnectionOwnership(supabase, auth, connection_id);
            if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);

            if (action === 'save') {
                const { error } = await supabase.from('user_memories').insert({ connection_id, text });
                if (error) throw error;
                return jsonResponse({ success: true, message: `Memory saved: "${text}"` });
            }

            if (action === 'search') {
                const { data } = await supabase
                    .from('user_memories')
                    .select('text, metadata, created_at')
                    .eq('connection_id', connection_id)
                    .ilike('text', `%${query || ''}%`)
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

async function executeTool(
    supabase: any,
    toolName: string,
    args: Record<string, any>,
    connectionId: string,
    devices: any[],
    verifiedConn?: any
): Promise<any> {
    switch (toolName) {
        case 'get_lights': return filterDevices(devices, 'light', args.room);
        case 'get_switches': return filterDevices(devices, 'switch', args.room);
        case 'get_climate': return filterDevices(devices, 'climate', args.room);
        case 'get_covers': return filterDevices(devices, 'cover', args.room);
        case 'get_automations': return filterDevices(devices, 'automation', args.filter);

        case 'search_devices': {
            const query = (args.query || '').toLowerCase();
            const tokens = query.split(/[\s,]+/).filter((t: string) => t.length > 2 && !['turn', 'check', 'set', 'get', 'what', 'show'].includes(t));
            if (tokens.length === 0 && query.length > 0) tokens.push(query);

            return devices.filter(d => {
                const name = (d.attributes?.friendly_name || d.entity_id || '').toLowerCase();
                const entityId = (d.entity_id || '').toLowerCase();
                if (name.includes(query) || entityId.includes(query)) return true;
                return tokens.some((token: string) => name.includes(token) || entityId.includes(token));
            }).slice(0, 20);
        }

        case 'save_memory':
            if (!connectionId) return { error: 'connection_id required' };
            await supabase.from('user_memories').insert({ connection_id: connectionId, text: args.text });
            return `Memory saved: "${args.text}"`;

        case 'search_memory': {
            if (!connectionId) return [];
            const { data } = await supabase
                .from('user_memories')
                .select('text')
                .eq('connection_id', connectionId)
                .ilike('text', `%${args.query || ''}%`);
            return data?.map((m: any) => m.text) || [];
        }

        case 'execute_ha_service':
            return {
                action_type: 'ha_service_call',
                entity_id: args.entity_id,
                service: args.service,
                data: args.data || {}
            };

        case 'get_history': {
            // SSRF-SAFE: Always load HA URL & token from verified DB connection, NEVER trust caller-supplied URL!
            if (!verifiedConn?.api_url || !verifiedConn?.api_token) {
                return { error: 'get_history requires a valid connection_id with stored Home Assistant credentials' };
            }
            const baseUrl = String(verifiedConn.api_url).replace(/\/+$/, '');
            if (!isSafeExternalUrl(baseUrl)) {
                return { error: 'Stored Home Assistant URL is not permitted' };
            }

            const { start_time, end_time, entity_ids, significant_changes_only } = args;
            const startDate = start_time || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const endDate = end_time || new Date().toISOString();

            let historyUrl = `${baseUrl}/api/history/period/${encodeURIComponent(startDate)}?end_time=${encodeURIComponent(endDate)}`;
            if (significant_changes_only) historyUrl += '&significant_changes_only=1';
            if (entity_ids && Array.isArray(entity_ids) && entity_ids.length > 0) {
                historyUrl += `&filter_entity_id=${encodeURIComponent(entity_ids.slice(0, 40).join(','))}`;
            }

            try {
                const historyResp = await fetchWithTimeout(historyUrl, {
                    headers: {
                        'Authorization': `Bearer ${verifiedConn.api_token}`,
                        'Content-Type': 'application/json'
                    }
                }, 15000);

                if (!historyResp.ok) {
                    const errorBody = await historyResp.text();
                    return { error: `HA API error: ${historyResp.status} - ${errorBody.substring(0, 200)}` };
                }

                const historyData = await historyResp.json();
                return (historyData || []).map((entityHistory: any[]) => {
                    if (!entityHistory || entityHistory.length === 0) return null;
                    const entityId = entityHistory[0]?.entity_id;
                    const states = entityHistory.map((s: any) => ({ state: s.state, last_changed: s.last_changed }));
                    return { entity_id: entityId, changes: states.length, states: states.slice(0, 50) };
                }).filter(Boolean);
            } catch (e: any) {
                return { error: `History fetch failed: ${e.message}` };
            }
        }

        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

function filterDevices(devices: any[], domain: string, room?: string): any[] {
    return devices.filter(d => {
        const entityDomain = d.entity_id?.split('.')[0];
        if (entityDomain !== domain) return false;
        if (room) {
            const name = (d.attributes?.friendly_name || d.entity_id || '').toLowerCase();
            const entityRoom = extractRoom(d);
            if (!name.includes(room.toLowerCase()) && entityRoom !== room.toLowerCase()) return false;
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
    const friendlyName = (entity.attributes?.friendly_name || '').toLowerCase();
    const entityId = (entity.entity_id || '').toLowerCase();
    const rooms = ['living', 'bedroom', 'kitchen', 'bathroom', 'office', 'garage', 'basement', 'attic', 'dining', 'hallway',
        'woonkamer', 'slaapkamer', 'keuken', 'badkamer', 'kantoor', 'kelder', 'zolder', 'eetkamer', 'gang', 'tuin'];
    for (const room of rooms) {
        if (friendlyName.includes(room) || entityId.includes(room)) return room;
    }
    return null;
}

function jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
}
