import { supabase } from '../lib/supabase';
// Reuse base helpers from home-assistant.ts but add specific registry fetchers
const HA_URL = import.meta.env.VITE_HA_URL;
const HA_TOKEN = import.meta.env.VITE_HA_TOKEN;
function getHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
}
// Helper to resolve URL (keep consistent with existing utils)
function getUrl(path, _baseUrl) {
    if (_baseUrl) {
        const base = _baseUrl.replace(/\/$/, '');
        const cleanPath = path.startsWith('/') ? path : `/${path}`;
        return `${base}${cleanPath}`;
    }
    return path;
}
// @ts-ignore
import { logger } from './logger';
/** Fetch all Areas (Rooms) from HA */
export async function fetchHAAreas(url, token) {
    logger.info(`fetchHAAreas: Requesting areas from ${url}`);
    // ... [Original Body] ...
    const response = await fetch(getUrl('/api/template', url), {
        method: 'POST',
        headers: getHeaders(token),
        body: JSON.stringify({
            template: `
        {% set areas = namespace(items=[]) %}
        {% for area_id in areas() %}
            {% set area = area_id | area_name %}
             {% set items = areas.items.append({ "area_id": area_id, "name": area }) %}
        {% endfor %}
        {{ areas.items | to_json }}
        `
        })
    });
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
export async function fetchSmartHASync(url, token) {
    logger.info(`fetchSmartHASync: Requesting topology from ${url}`);
    // ... [Original Template] ...
    const template = `
    {% set output = namespace(areas=[], orphans=[]) %}
    
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
    
    {{ { "areas": output.areas, "orphans": output.orphans } | to_json }}
    `;
    const response = await fetch(getUrl('/api/template', url), {
        method: 'POST',
        headers: getHeaders(token),
        body: JSON.stringify({ template })
    });
    if (!response.ok) {
        const errorText = await response.text();
        logger.error(`fetchSmartHASync: Failed ${response.status}`, errorText);
        throw new Error('Failed to fetch sync data');
    }
    const text = await response.text();
    logger.info(`fetchSmartHASync: Received topology (length: ${text.length})`);
    try {
        return JSON.parse(text);
    }
    catch (e) {
        logger.error(`fetchSmartHASync: JSON Parse Error`, { text, error: e });
        throw e;
    }
}
/**
 * Orchestrator:
 */
export async function processHASync(connectionId, apiUrl, apiToken, userId) {
    logger.info('processHASync: Starting Sync...', { connectionId, apiUrl });
    // 1. Fetch Topology
    let topology = { areas: [], orphans: [] };
    let useFallback = false;
    try {
        topology = await fetchSmartHASync(apiUrl, apiToken);
        logger.info('processHASync: Topology fetched', { areaCount: topology.areas?.length, orphanCount: topology.orphans?.length });
        if ((!topology.areas || topology.areas.length === 0) && (!topology.orphans || topology.orphans.length === 0)) {
            logger.warn('processHASync: Topology empty, switching to Fallback Mode');
            useFallback = true;
        }
    }
    catch (err) {
        logger.error('processHASync: Smart Sync Failed, switching to Fallback Mode', err);
        useFallback = true;
    }
    // 2. Fetch States (for details)
    logger.info('processHASync: Fetching States...');
    const statesResponse = await fetch(getUrl('/api/states', apiUrl), {
        headers: getHeaders(apiToken)
    });
    if (!statesResponse.ok) {
        const errText = await statesResponse.text();
        logger.error(`processHASync: Fetch States Failed ${statesResponse.status}`, errText);
        throw new Error('Failed to fetch states');
    }
    const states = await statesResponse.json();
    logger.info(`processHASync: Received ${states.length} states`);
    const stateMap = new Map(states.map(s => [s.entity_id, s]));
    // 3. Build Tiles
    const tiles = [];
    // Map of Domain -> Tile Type
    const getDeviceType = (domain) => {
        const types = {
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
        };
        return types[domain] || null;
    };
    const getIcon = (domain, state) => {
        // Simple mapping, can be expanded
        const icons = {
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
        };
        return icons[domain] || '📦';
    };
    // Helper to process a list of entity IDs into devices
    const processEntityList = (entityIds) => {
        const devices = [];
        for (const entityId of entityIds) {
            const stateObj = stateMap.get(entityId);
            if (!stateObj)
                continue;
            const domain = entityId.split('.')[0];
            const type = getDeviceType(domain);
            // We only add known types to the Dashboard
            if (type) {
                devices.push({
                    id: `dev-${entityId.replace('.', '-')}`,
                    type,
                    name: stateObj.attributes.friendly_name || entityId,
                    icon: getIcon(domain, stateObj),
                    entityId: entityId,
                    state: stateObj.state // Include initial state
                });
            }
        }
        return devices;
    };
    if (useFallback) {
        // FALLBACK: Dump everything into "All Devices"
        const allEntityIds = states.map(s => s.entity_id);
        const allDevices = processEntityList(allEntityIds);
        if (allDevices.length > 0) {
            tiles.push({
                id: 'room-all',
                type: 'room',
                roomId: 'all',
                roomName: 'All Devices',
                roomIcon: '🏠',
                order: 0,
                devices: allDevices
            });
        }
    }
    else {
        // STANDARD: Process Areas -> Tiles
        for (const area of topology.areas) {
            if (!area.name)
                continue;
            const tileId = `room-${area.id}`;
            const devices = processEntityList(area.entities);
            tiles.push({
                id: tileId,
                type: 'room',
                roomId: area.id,
                roomName: area.name,
                roomIcon: 'not_found',
                order: tiles.length,
                devices
            });
        }
        // Process Orphans -> Unassigned Room
        if (topology.orphans && topology.orphans.length > 0) {
            const orphanDevices = processEntityList(topology.orphans);
            if (orphanDevices.length > 0) {
                tiles.push({
                    id: 'room-unassigned',
                    type: 'room',
                    roomId: 'unassigned', // Special ID
                    roomName: 'Unassigned',
                    roomIcon: '📦',
                    order: tiles.length,
                    devices: orphanDevices
                });
            }
        }
    }
    // Update icons for known room names
    tiles.forEach(t => {
        if (t.roomId === 'unassigned' || t.roomId === 'all')
            return; // Skip icon logic for unassigned or all
        const lower = t.roomName.toLowerCase();
        if (lower.includes('bed'))
            t.roomIcon = '🛏️';
        else if (lower.includes('living'))
            t.roomIcon = '🛋️';
        else if (lower.includes('kitchen'))
            t.roomIcon = '🍳';
        else if (lower.includes('bath'))
            t.roomIcon = '🚿';
        else if (lower.includes('office') || lower.includes('study'))
            t.roomIcon = '💻';
        else if (lower.includes('garage'))
            t.roomIcon = '🚗';
        else if (lower.includes('garden'))
            t.roomIcon = '🌱';
        else
            t.roomIcon = '🏠';
    });
    // 4. Save to LocalStorage (Dashboard)
    logger.info(`processHASync: Generating ${tiles.length} tiles (Total devices: ${tiles.reduce((acc, t) => acc + t.devices.length, 0)})`);
    localStorage.setItem('dashboard-tiles', JSON.stringify(tiles));
    // 5. Sync to Supabase (Rooms)
    logger.info('processHASync: Syncing rooms to Supabase...');
    const { error: delError } = await supabase
        .from('rooms')
        .delete()
        .eq('connection_id', connectionId);
    if (delError)
        logger.error('processHASync: Error clearing rooms', delError);
    // Prepare batch insert
    const roomRows = tiles.map(t => ({
        connection_id: connectionId,
        name: t.roomName,
        description: `Imported from Home Assistant Area: ${t.roomId}`,
    }));
    if (roomRows.length > 0) {
        const { error: insError } = await supabase
            .from('rooms')
            .insert(roomRows);
        if (insError)
            logger.error('processHASync: Error syncing rooms', insError);
        else
            logger.info('processHASync: Rooms synced successfully');
    }
    return tiles;
}
