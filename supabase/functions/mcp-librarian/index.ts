/**
 * MCP Librarian - Supabase Edge Function
 * Builds and maintains the tenant-scoped Custom MCP TOON catalog.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { chatCompletion, parseJSONResponse } from "../_shared/llm-service.ts";
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from "../_shared/auth.ts";

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function toTOON(items: any[], name: string, fields: string[]): string {
    if (!items || items.length === 0) {
        return `${name}[0]{${fields.join(',')}}`;
    }
    const header = `${name}[${items.length}]{${fields.join(',')}}`;
    const rows = items.map(item =>
        fields.map(f => {
            const val = item[f];
            return val == null ? '' : String(val).replace(/\t/g, ' ').replace(/\n/g, ' ');
        }).join('\t')
    );
    return [header, ...rows].join('\n');
}

const LIBRARIAN_PROMPT = `
You are the MCP Librarian - convert raw Home Assistant service data into a compact MCP tool entry.
Return valid JSON ONLY:
{
  "name": "domain.service_name",
  "category": "devices.lights|devices.switches|devices.climate|devices.covers|devices.media|devices.locks|devices.fans|devices.sensors|automation.control|automation.scenes|system.scripts|system.other",
  "description": "ONE clear sentence describing what this tool does.",
  "when_to_use": "Keywords and phrases that should trigger this tool."
}
`;

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: CORS_HEADERS });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/mcp-librarian/, '') || '/';

    try {
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) return jsonResponse({ error: auth.error }, auth.status || 401);

        if (path === '/sync-states' && req.method === 'POST') {
            const { connection_id, states } = await req.json();
            if (!connection_id) return jsonResponse({ error: 'connection_id required' }, 400);
            if (!states || !Array.isArray(states)) return jsonResponse({ error: 'states array required' }, 400);

            const ownership = await verifyConnectionOwnership(supabase, auth, connection_id);
            if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);

            const { error } = await supabase
                .from('device_states')
                .upsert(states.map((s: any) => ({
                    connection_id,
                    entity_id: s.entity_id,
                    state: s.state,
                    attributes: s.attributes || {},
                    last_updated: new Date().toISOString()
                })), { onConflict: 'connection_id,entity_id' });

            if (error) return jsonResponse({ error: error.message }, 500);
            return jsonResponse({ success: true, count: states.length });
        }

        if (path === '/sync' && req.method === 'POST') {
            const { connection_id, entities, services, sync_mode = 'replace' } = await req.json();
            if (!connection_id) return jsonResponse({ error: 'connection_id required' }, 400);

            const ownership = await verifyConnectionOwnership(supabase, auth, connection_id);
            if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);

            let existingDevices: any[] = [];
            let existingTools: any[] = [];
            let existingDomains: string[] = [];

            if (sync_mode === 'start') {
                await supabase.from('mcp_resources').delete().eq('connection_id', connection_id);
                await supabase.from('mcp_tools').delete().eq('connection_id', connection_id);
                await supabase.from('mcp_raw_sync').delete().eq('connection_id', connection_id);
            } else if (sync_mode === 'append' || sync_mode === 'complete') {
                const { data: existing } = await supabase
                    .from('mcp_raw_sync')
                    .select('accumulated_devices, accumulated_tools, service_domains')
                    .eq('connection_id', connection_id)
                    .maybeSingle();

                if (existing) {
                    existingDevices = existing.accumulated_devices || [];
                    existingTools = existing.accumulated_tools || [];
                    existingDomains = Array.isArray(existing.service_domains) ? existing.service_domains : [];
                }
            }

            const newDevices = (entities || []).map((e: any) => ({
                entity_id: e.entity_id,
                name: e.attributes?.friendly_name || e.entity_id,
                domain: (e.entity_id || '').split('.')[0],
                room: extractRoom(e) || '',
                state: e.state || 'unknown'
            }));

            const deviceMap = new Map();
            for (const d of existingDevices) deviceMap.set(d.entity_id, d);
            for (const d of newDevices) deviceMap.set(d.entity_id, d);
            const allDevices = Array.from(deviceMap.values());

            const domains = new Set<string>();
            for (const entity of entities || []) {
                const domain = entity.entity_id?.split('.')[0];
                if (domain) domains.add(domain);
            }

            const servicesToFormat: any[] = [];
            if (services) {
                for (const [domain, domainServices] of Object.entries(services)) {
                    if (domains.size > 0 && !domains.has(domain)) continue;
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

            const newTools: any[] = [];
            const BATCH_SIZE = 15;
            for (let i = 0; i < Math.min(servicesToFormat.length, 100); i += BATCH_SIZE) {
                const batch = servicesToFormat.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(svc => formatWithLibrarian(svc)));
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

            const toolMap = new Map();
            for (const t of existingTools) toolMap.set(t.name, t);
            for (const t of newTools) toolMap.set(t.name, t);
            const allTools = Array.from(toolMap.values());

            const mergedDomains = Array.from(new Set([
                ...existingDomains,
                ...(services ? Object.keys(services) : [])
            ]));

            const toonDevices = toTOON(allDevices, 'devices', ['entity_id', 'name', 'domain', 'room', 'state']);
            const toonTools = toTOON(allTools, 'tools', ['name', 'category', 'description', 'when_to_use']);

            let toonAgents = 'agents[0]{name,description,when_to_use}';
            if (sync_mode === 'complete' || sync_mode === 'replace') {
                const { data: agents } = await supabase
                    .from('agents')
                    .select('name, description, when_to_use');
                toonAgents = toTOON(agents || [], 'agents', ['name', 'description', 'when_to_use']);
            }

            const { error: syncError } = await supabase
                .from('mcp_raw_sync')
                .upsert({
                    connection_id,
                    entity_count: allDevices.length,
                    service_domains: mergedDomains,
                    toon_devices: toonDevices,
                    toon_tools: toonTools,
                    toon_agents: toonAgents,
                    accumulated_devices: allDevices,
                    accumulated_tools: allTools,
                    synced_at: new Date().toISOString()
                }, { onConflict: 'connection_id' });

            if (syncError) {
                return jsonResponse({ error: 'Failed to store TOON catalog: ' + syncError.message }, 500);
            }

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

        if (path === '/format' && req.method === 'POST') {
            const { service } = await req.json();
            const formatted = await formatWithLibrarian(service);
            return jsonResponse({ formatted });
        }

        if (path === '/tools' && req.method === 'GET') {
            const connectionId = url.searchParams.get('connection_id');
            if (connectionId) {
                const ownership = await verifyConnectionOwnership(supabase, auth, connectionId);
                if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);
            }

            let query = supabase.from('mcp_tools').select('*').order('category');
            if (connectionId) {
                query = query.or(`connection_id.is.null,connection_id.eq.${connectionId}`);
            } else {
                query = query.is('connection_id', null);
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

async function formatWithLibrarian(service: any): Promise<any> {
    const prompt = `RAW SERVICE DATA:\n${JSON.stringify(service, null, 2)}`;
    try {
        const response = await chatCompletion([
            { role: 'system', content: LIBRARIAN_PROMPT },
            { role: 'user', content: prompt }
        ], 500, 0.1, undefined, undefined, undefined, { effort: 'low' }, 'lite_fast');

        return parseJSONResponse(typeof response === 'string' ? response : JSON.stringify(response)) || basicFormat(service);
    } catch {
        return basicFormat(service);
    }
}

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
        when_to_use: `User wants to ${service.service.replace(/_/g, ' ')} a ${service.domain}`
    };
}

function jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
}

function extractRoom(entity: any): string | null {
    const friendlyName = (entity.attributes?.friendly_name || '').toLowerCase();
    const entityId = (entity.entity_id || '').toLowerCase();
    const rooms = ['living', 'bedroom', 'kitchen', 'bathroom', 'office', 'garage', 'basement', 'attic', 'dining', 'hallway', 'garden', 'patio',
        'woonkamer', 'slaapkamer', 'keuken', 'badkamer', 'kantoor', 'kelder', 'zolder', 'eetkamer', 'gang', 'tuin'];
    for (const room of rooms) {
        if (friendlyName.includes(room) || entityId.includes(room)) return room;
    }
    return null;
}
