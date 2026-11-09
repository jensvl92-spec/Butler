
import { HADevice, Room } from '../types'
import { supabase } from '../lib/supabase'

export interface HAArea {
    area_id: string
    name: string
    picture?: string
}

export interface HAEntityRegistryEntry {
    config_entry_id: string | null
    device_id: string | null
    area_id: string | null
    disabled_by: string | null
    entity_id: string
    name: string | null
    original_name?: string
    platform: string
}

export interface HADeviceRegistryEntry {
    id: string
    area_id: string | null
    name: string | null
    name_by_user?: string | null
    manufacturer: string | null
    model: string | null
}

// Reuse base helpers from home-assistant.ts but add specific registry fetchers
const HA_URL = import.meta.env.VITE_HA_URL
const HA_TOKEN = import.meta.env.VITE_HA_TOKEN

function getHeaders(token: string) {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    }
}

// Helper to resolve URL (keep consistent with existing utils)
function getUrl(path: string, _baseUrl?: string): string {
    if (_baseUrl) {
        const base = _baseUrl.replace(/\/$/, '')
        const cleanPath = path.startsWith('/') ? path : `/${path}`
        return `${base}${cleanPath}`
    }
    return path
}


// @ts-ignore
import { logger } from './logger';

/** Fetch all Areas (Rooms) from HA */
export async function fetchHAAreas(url: string, token: string): Promise<HAArea[]> {
    logger.info(`fetchHAAreas: Requesting areas from ${url}`);

    // ... [Original Body] ...
    const response = await fetch(getUrl('/api/template', url), {
        method: 'POST',
        headers: getHeaders(token),
        body: JSON.stringify({
            template: `
        {% set area_ns = namespace(items=[]) %}
        {% for area_id in areas() %}
            {% set area = area_id | area_name %}
            {% set _ = area_ns.items.append({ "area_id": area_id, "name": area }) %}
        {% endfor %}
        {{ area_ns.items | to_json }}
        `
        })
    })

    if (!response.ok) {
        const errorText = await response.text();
        logger.error(`fetchHAAreas: Failed ${response.status}`, errorText);
        throw new Error(`Failed to fetch areas: ${response.status}`);
    }

    const data = await response.json();
    logger.info(`fetchHAAreas: Received ${data.length} areas`);
    return data;
}

/** 
 * Comprehensive Fetch that gets the State Machine and correlates it 
 */
export async function fetchSmartHASync(url: string, token: string) {
    logger.info(`fetchSmartHASync: Requesting topology from ${url}`);

    // Template with graceful backwards compatibility for floors (HA 2024.4+)
    const template = `
    {% set output = namespace(floors=[], areas=[], orphans=[]) %}
    {% if floors is defined %}
      {% for f_id in floors() %}
        {% set output.floors = output.floors + [{
          "id": f_id,
          "name": floor_name(f_id),
          "areas": floor_areas(f_id)
        }] %}
      {% endfor %}
    {% endif %}
    
    {% for area_id in areas() %}
      {% set output.areas = output.areas + [{
        "id": area_id,
        "name": area_name(area_id),
        "entities": area_entities(area_id)
      }] %}
    {% endfor %}
    
    {% for state in states %}
      {% if area_id(state.entity_id) == none %}
        {% set output.orphans = output.orphans + [state.entity_id] %}
      {% endif %}
    {% endfor %}
    
    {{ { "floors": output.floors, "areas": output.areas, "orphans": output.orphans } | to_json }}
    `

    const response = await fetch(getUrl('/api/template', url), {
        method: 'POST',
        headers: getHeaders(token),
        body: JSON.stringify({ template })
    })

    if (!response.ok) {
        const errorText = await response.text();
        logger.error(`fetchSmartHASync: Failed ${response.status}`, errorText);
        throw new Error('Failed to fetch sync data');
    }

    const text = await response.text();
    logger.info(`fetchSmartHASync: Received topology (length: ${text.length})`);
    try {
        const parsed = JSON.parse(text);
        try {
            localStorage.setItem('ha_topology_latest', text);
        } catch { }
        return parsed;
    } catch (e) {
        logger.error(`fetchSmartHASync: JSON Parse Error`, { text, error: e });
        throw e;
    }
}

/** 
 * Orchestrator:
 */
export async function processHASync(
    connectionId: string,
    apiUrl: string,
    apiToken: string,
    userId: string
) {
    logger.info('processHASync: Starting Sync...', { connectionId, apiUrl });
    // 1. Fetch Topology
    let topology: { areas: any[], orphans: any[] } = { areas: [], orphans: [] }
    let useFallback = false

    try {
        topology = await fetchSmartHASync(apiUrl, apiToken)
        logger.info('processHASync: Topology fetched', { areaCount: topology.areas?.length, orphanCount: topology.orphans?.length });

        if ((!topology.areas || topology.areas.length === 0) && (!topology.orphans || topology.orphans.length === 0)) {
            logger.warn('processHASync: Topology empty, switching to Fallback Mode');
            useFallback = true
        }
    } catch (err) {
        logger.error('processHASync: Smart Sync Failed, switching to Fallback Mode', err);
        useFallback = true
    }

    // 2. Fetch States (for details)
    logger.info('processHASync: Fetching States...');
    const statesResponse = await fetch(getUrl('/api/states', apiUrl), {
        headers: getHeaders(apiToken)
    })
    if (!statesResponse.ok) {
        const errText = await statesResponse.text();
        logger.error(`processHASync: Fetch States Failed ${statesResponse.status}`, errText);
        throw new Error('Failed to fetch states');
    }

    const states: any[] = await statesResponse.json()
    logger.info(`processHASync: Received ${states.length} states`);
    const stateMap = new Map(states.map(s => [s.entity_id, s]))

    // 3. Build Tiles
    const tiles = []

    // Map of Domain -> Tile Type
    const getDeviceType = (domain: string): string | null => {
        const types: Record<string, string> = {
            light: 'light',
            switch: 'switch',
            media_player: 'media',
            climate: 'climate',
            fan: 'fan',
            cover: 'cover',
            lock: 'lock',
            vacuum: 'vacuum',
            sensor: 'sensor',
            binary_sensor: 'binary_sensor',
            camera: 'camera',
            scene: 'scene',
            script: 'script',
            automation: 'automation'
        }
        return types[domain] || null
    }

    const getIcon = (domain: string, state: any): string => {
        // Simple mapping, can be expanded
        const icons: Record<string, string> = {
            light: '💡',
            switch: '🔌',
            media_player: '📺',
            climate: '🌡️',
            fan: '🌀',
            cover: '🪟',
            lock: '🔒',
            vacuum: '🧹',
            sensor: '👁️',
            binary_sensor: 'qh',
            camera: '📷',
            scene: '🎬',
            script: '📜',
            automation: '🤖'
        }
        return icons[domain] || '📦'
    }

    // Helper to process a list of entity IDs into devices
    const processEntityList = (entityIds: string[]): any[] => {
        const devices = []
        for (const entityId of entityIds) {
            const stateObj = stateMap.get(entityId)
            if (!stateObj) continue

            const domain = entityId.split('.')[0]
            const type = getDeviceType(domain)

            // We only add known types to the Dashboard
            if (type) {
                devices.push({
                    id: `dev-${entityId.replace('.', '-')}`,
                    type,
                    name: stateObj.attributes.friendly_name || entityId,
                    icon: getIcon(domain, stateObj),
                    entityId: entityId,
                    state: stateObj.state // Include initial state
                })
            }
        }
        return devices
    }

    if (useFallback) {
        // FALLBACK: Dump everything into "All Devices"
        const allEntityIds = states.map(s => s.entity_id)
        const allDevices = processEntityList(allEntityIds)

        if (allDevices.length > 0) {
            tiles.push({
                id: 'room-all',
                type: 'room',
                roomId: 'all',
                roomName: 'All Devices',
                roomIcon: '🏠',
                order: 0,
                devices: allDevices
            })
        }
    } else {
        // STANDARD: Process Areas -> Tiles
        for (const area of topology.areas) {
            if (!area.name) continue

            const tileId = `room-${area.id}`
            const devices = processEntityList(area.entities)

            tiles.push({
                id: tileId,
                type: 'room',
                roomId: area.id,
                roomName: area.name,
                roomIcon: 'not_found',
                order: tiles.length,
                devices
            })
        }

        // Process Orphans: Only attach to existing Areas if the name matches.
        // Never invent synthetic rooms; any remaining devices go into a single unassigned tile.
        if (topology.orphans && topology.orphans.length > 0) {
            const orphanDevices = processEntityList(topology.orphans);
            const unassignedDevices: any[] = [];

            for (const dev of orphanDevices) {
                const searchStr = `${dev.entityId} ${dev.name}`.toLowerCase();
                let matched = false;

                // Check if it matches an existing Area directly
                for (const tile of tiles) {
                    const areaNameLower = tile.roomName.toLowerCase();
                    if (searchStr.includes(areaNameLower) || (areaNameLower.length > 3 && searchStr.includes(areaNameLower.substring(0, areaNameLower.length - 1)))) {
                        tile.devices.push(dev);
                        matched = true;
                        break;
                    }
                }

                if (!matched) {
                    unassignedDevices.push(dev);
                }
            }

            if (unassignedDevices.length > 0) {
                tiles.push({
                    id: 'room-unassigned',
                    type: 'room',
                    roomId: 'unassigned',
                    roomName: 'Niet-toegewezen apparaten',
                    roomIcon: '📦',
                    order: tiles.length,
                    devices: unassignedDevices
                });
            }
        }
    }

    // Update icons for all tiles (Bilingual Dutch & English)
    tiles.forEach(t => {
        if (t.roomIcon && t.roomIcon !== 'not_found') return;
        const lower = t.roomName.toLowerCase();
        if (lower.includes('bed') || lower.includes('slaap')) t.roomIcon = '🛏️';
        else if (lower.includes('living') || lower.includes('woon') || lower.includes('salon')) t.roomIcon = '🛋️';
        else if (lower.includes('kitchen') || lower.includes('keuken') || lower.includes('kook')) t.roomIcon = '🍳';
        else if (lower.includes('bath') || lower.includes('bad') || lower.includes('douche')) t.roomIcon = '🚿';
        else if (lower.includes('office') || lower.includes('study') || lower.includes('bureau') || lower.includes('kantoor')) t.roomIcon = '💻';
        else if (lower.includes('garage') || lower.includes('oprit') || lower.includes('carport')) t.roomIcon = '🚗';
        else if (lower.includes('garden') || lower.includes('tuin') || lower.includes('terras') || lower.includes('buiten')) t.roomIcon = '🌱';
        else if (lower.includes('gang') || lower.includes('hall') || lower.includes('inkom')) t.roomIcon = '🚪';
        else if (lower.includes('was') || lower.includes('berg') || lower.includes('kelder') || lower.includes('zolder')) t.roomIcon = '🧺';
        else if (lower.includes('energie') || lower.includes('energy') || lower.includes('meter') || lower.includes('solar')) t.roomIcon = '⚡';
        else if (lower.includes('beveilig') || lower.includes('alarm') || lower.includes('camera')) t.roomIcon = '🛡️';
        else t.roomIcon = '🏠';
    });

    // 4. Save to LocalStorage (Dashboard)
    logger.info(`processHASync: Generating ${tiles.length} tiles (Total devices: ${tiles.reduce((acc, t) => acc + t.devices.length, 0)})`);
    localStorage.setItem('dashboard-tiles', JSON.stringify(tiles))
    localStorage.setItem(`dashboard_tiles_${connectionId}`, JSON.stringify(tiles))

    // 5. Sync to Supabase (Rooms) - only genuine areas, not the unassigned bucket
    logger.info('processHASync: Syncing rooms to Supabase...');
    const { error: delError } = await supabase
        .from('rooms')
        .delete()
        .eq('connection_id', connectionId)

    if (delError) logger.error('processHASync: Error clearing rooms', delError);

    // Prepare batch insert (exclude virtual unassigned bucket from db rooms)
    const roomRows = tiles
        .filter(t => t.roomId !== 'unassigned')
        .map(t => ({
            connection_id: connectionId,
            name: t.roomName,
            description: `Imported from Home Assistant Area: ${t.roomId}`,
        }))

    if (roomRows.length > 0) {
        const { error: insError } = await supabase
            .from('rooms')
            .insert(roomRows)
        if (insError) logger.error('processHASync: Error syncing rooms', insError)
        else logger.info('processHASync: Rooms synced successfully');
    }

    return tiles
}

// -------------------------------------------------------------
// Extended Home Assistant API Connectors (History, Logbook, Camera, Todo, Calendar, Automation)
// -------------------------------------------------------------

/** Convert ArrayBuffer to Base64 safely without call stack overflow */
function bufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(binary);
}

/** 1. Fetch History and compute statistical summary */
export async function fetchHAHistory(
    apiUrl: string,
    apiToken: string,
    entityId: string,
    hoursAgo: number = 24
) {
    const startTimeIso = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
    const url = `${getUrl(`/api/history/period/${encodeURIComponent(startTimeIso)}`, apiUrl)}?filter_entity_id=${encodeURIComponent(entityId)}&minimal_response=1`;
    logger.info(`fetchHAHistory: Requesting history for ${entityId} (${hoursAgo}h ago)`);

    const res = await fetch(url, { headers: getHeaders(apiToken) });
    if (!res.ok) {
        throw new Error(`HA History fetch failed with status ${res.status}`);
    }

    const data: any[][] = await res.json();
    if (!data || data.length === 0 || !data[0] || data[0].length === 0) {
        return { entity_id: entityId, message: 'Geen historische data gevonden voor deze periode.' };
    }

    const points = data[0];
    const states = points.map(p => ({
        state: p.state,
        val: parseFloat(p.state),
        time: p.last_changed || p.last_updated
    }));

    const validNums = states.filter(s => !isNaN(s.val));
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];

    if (validNums.length > 0) {
        const vals = validNums.map(v => v.val);
        const minVal = Math.min(...vals);
        const maxVal = Math.max(...vals);
        const avgVal = vals.reduce((a, b) => a + b, 0) / vals.length;
        const startVal = validNums[0].val;
        const endVal = validNums[validNums.length - 1].val;
        const change = endVal - startVal;

        return {
            entity_id: entityId,
            period_hours: hoursAgo,
            start_time: firstPoint.last_changed,
            end_time: lastPoint.last_changed,
            total_data_points: points.length,
            current_state: lastPoint.state,
            start_state: firstPoint.state,
            numeric_summary: {
                start_value: Math.round(startVal * 100) / 100,
                end_value: Math.round(endVal * 100) / 100,
                delta_change: Math.round(change * 100) / 100,
                min: Math.round(minVal * 100) / 100,
                max: Math.round(maxVal * 100) / 100,
                average: Math.round(avgVal * 100) / 100
            },
            unit: lastPoint.attributes?.unit_of_measurement || null
        };
    }

    // Categorical / string states (e.g. on/off, open/closed)
    const transitions = points.slice(-10).map(p => ({
        state: p.state,
        time: new Date(p.last_changed).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })
    }));

    return {
        entity_id: entityId,
        period_hours: hoursAgo,
        current_state: lastPoint.state,
        transitions_count: points.length,
        recent_changes: transitions
    };
}

/** 2. Fetch Logbook Events */
export async function fetchHALogbook(
    apiUrl: string,
    apiToken: string,
    entityId?: string,
    hoursAgo: number = 24
) {
    const startTimeIso = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
    let url = `${getUrl(`/api/logbook/${encodeURIComponent(startTimeIso)}`, apiUrl)}`;
    if (entityId) {
        url += `?entity=${encodeURIComponent(entityId)}`;
    }
    logger.info(`fetchHALogbook: Requesting logbook (${hoursAgo}h ago)${entityId ? ` for ${entityId}` : ''}`);

    const res = await fetch(url, { headers: getHeaders(apiToken) });
    if (!res.ok) {
        throw new Error(`HA Logbook fetch failed with status ${res.status}`);
    }

    const events: any[] = await res.json();
    if (!events || events.length === 0) {
        return { message: 'Geen logboekgebeurtenissen gevonden voor deze periode.' };
    }

    const formatted = events.slice(-30).reverse().map(e => ({
        time: new Date(e.when).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        date: new Date(e.when).toLocaleDateString('nl-BE'),
        entity_id: e.entity_id,
        name: e.name,
        message: e.message,
        state: e.state
    }));

    return {
        total_events: events.length,
        period_hours: hoursAgo,
        events: formatted
    };
}

/** 3. Fetch Camera Snapshot as Base64 JPEG */
export async function fetchHACameraSnapshot(
    apiUrl: string,
    apiToken: string,
    cameraEntityId: string
): Promise<{ base64: string; dataUrl: string; entity_id: string }> {
    const url = getUrl(`/api/camera_proxy/${encodeURIComponent(cameraEntityId)}`, apiUrl);
    logger.info(`fetchHACameraSnapshot: Fetching snapshot from ${cameraEntityId}`);

    const res = await fetch(url, { headers: getHeaders(apiToken) });
    if (!res.ok) {
        throw new Error(`Failed to fetch camera snapshot (${res.status})`);
    }

    const buffer = await res.arrayBuffer();
    const base64 = bufferToBase64(buffer);
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    return {
        base64,
        dataUrl,
        entity_id: cameraEntityId
    };
}

/** 4. Fetch Todo Lists & Items */
export async function fetchHATodoItems(
    apiUrl: string,
    apiToken: string,
    listEntityId?: string
) {
    logger.info(`fetchHATodoItems: Fetching todo items${listEntityId ? ` for ${listEntityId}` : ''}`);

    // If specific list not provided, find available todo entities from /api/states
    let targetListId = listEntityId;
    if (!targetListId) {
        const statesRes = await fetch(getUrl('/api/states', apiUrl), { headers: getHeaders(apiToken) });
        if (statesRes.ok) {
            const states: any[] = await statesRes.json();
            const todoSensors = states.filter(s => s.entity_id.startsWith('todo.'));
            if (todoSensors.length > 0) {
                targetListId = todoSensors[0].entity_id;
            }
        }
    }

    if (!targetListId) {
        return { message: 'Geen to-do lijst of boodschappenlijst gevonden in Home Assistant.' };
    }

    // Modern HA: POST to /api/services/todo/get_items with return_response
    const serviceUrl = getUrl('/api/services/todo/get_items?return_response=1', apiUrl);
    try {
        const res = await fetch(serviceUrl, {
            method: 'POST',
            headers: getHeaders(apiToken),
            body: JSON.stringify({ entity_id: targetListId })
        });
        if (res.ok) {
            const data = await res.json();
            const items = data[targetListId]?.items || [];
            return {
                list_entity_id: targetListId,
                total_items: items.length,
                pending_items: items.filter((i: any) => i.status === 'needs_action'),
                completed_items: items.filter((i: any) => i.status === 'completed'),
                raw_items: items
            };
        }
    } catch (e: any) {
        logger.warn('fetchHATodoItems via get_items service failed, falling back:', e);
    }

    // Fallback: read state attribute
    const stateRes = await fetch(getUrl(`/api/states/${targetListId}`, apiUrl), { headers: getHeaders(apiToken) });
    if (stateRes.ok) {
        const stateObj = await stateRes.json();
        return {
            list_entity_id: targetListId,
            friendly_name: stateObj.attributes?.friendly_name || targetListId,
            item_count: stateObj.state,
            attributes: stateObj.attributes
        };
    }

    return { message: `Kon lijst ${targetListId} niet uitlezen.` };
}

/** 5. Manage Todo Items (Add, Update/Complete, Remove) */
export async function manageHATodoItem(
    apiUrl: string,
    apiToken: string,
    action: 'add' | 'update' | 'remove',
    params: { listEntityId: string; item: string; status?: 'needs_action' | 'completed' }
) {
    const { listEntityId, item, status } = params;
    let service = 'add_item';
    let serviceData: any = { entity_id: listEntityId, item };

    if (action === 'update') {
        service = 'update_item';
        serviceData = { entity_id: listEntityId, item, status: status || 'completed' };
    } else if (action === 'remove') {
        service = 'remove_item';
        serviceData = { entity_id: listEntityId, item: [item] };
    }

    const { callHAService } = await import('./home-assistant');
    await callHAService('todo', service, serviceData, apiUrl, apiToken);
    return {
        success: true,
        action,
        item,
        list_entity_id: listEntityId,
        message: `Item "${item}" ${action === 'add' ? 'toegevoegd aan' : action === 'update' ? 'bijgewerkt in' : 'verwijderd uit'} ${listEntityId}.`
    };
}

/** 6. Fetch Calendar Events */
export async function fetchHACalendarEvents(
    apiUrl: string,
    apiToken: string,
    calendarEntityId?: string,
    daysAhead: number = 7
) {
    logger.info(`fetchHACalendarEvents: Fetching calendar events (${daysAhead} days ahead)`);
    let calId = calendarEntityId;

    if (!calId) {
        const calsRes = await fetch(getUrl('/api/calendars', apiUrl), { headers: getHeaders(apiToken) });
        if (calsRes.ok) {
            const cals: any[] = await calsRes.json();
            if (cals && cals.length > 0) {
                calId = cals[0].entity_id;
            }
        }
    }

    if (!calId) {
        return { message: 'Geen actieve kalender gevonden in Home Assistant.' };
    }

    const startIso = new Date().toISOString();
    const endIso = new Date(Date.now() + daysAhead * 24 * 3600 * 1000).toISOString();
    const eventsUrl = `${getUrl(`/api/calendars/${encodeURIComponent(calId)}`, apiUrl)}?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;

    const res = await fetch(eventsUrl, { headers: getHeaders(apiToken) });
    if (!res.ok) {
        throw new Error(`Failed to fetch calendar events (${res.status})`);
    }

    const events: any[] = await res.json();
    return {
        calendar_entity_id: calId,
        period_days: daysAhead,
        total_events: events.length,
        events: events.map(ev => ({
            summary: ev.summary,
            start: ev.start?.dateTime || ev.start?.date || ev.start,
            end: ev.end?.dateTime || ev.end?.date || ev.end,
            description: ev.description || null,
            location: ev.location || null
        }))
    };
}

/** 7. Save and reload Home Assistant Automation */
export async function saveHAAutomation(
    apiUrl: string,
    apiToken: string,
    automationConfig: { id?: string; alias: string; description?: string; trigger: any[]; condition?: any[]; action: any[]; mode?: string }
) {
    const autoId = automationConfig.id || `butler_auto_${Date.now()}`;
    const payload = {
        ...automationConfig,
        id: autoId
    };

    logger.info(`saveHAAutomation: Creating automation ${autoId} (${payload.alias})`);
    const saveUrl = getUrl(`/api/config/automation/config/${encodeURIComponent(autoId)}`, apiUrl);
    const res = await fetch(saveUrl, {
        method: 'POST',
        headers: getHeaders(apiToken),
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Opslaan van automatisering mislukt (${res.status}): ${err}`);
    }

    // Reload automations
    try {
        const { callHAService } = await import('./home-assistant');
        await callHAService('automation', 'reload', {}, apiUrl, apiToken);
    } catch (reloadErr) {
        logger.warn('Automation reload warning:', reloadErr);
    }

    return {
        success: true,
        automation_id: autoId,
        alias: payload.alias,
        message: `Automatisering "${payload.alias}" succesvol opgeslagen en geactiveerd in Home Assistant!`
    };
}
