
import { HADevice } from '../types'
import { supabase } from '../lib/supabase'
import { buildHAUrl, sanitizeHAToken, fetchWithTimeout } from './home-assistant'
import { logger } from './logger'

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

function getHeaders(token: string, includeJsonContentType = true): Record<string, string> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${sanitizeHAToken(token)}`
    }
    if (includeJsonContentType) {
        headers['Content-Type'] = 'application/json'
    }
    return headers
}

function getUrl(path: string, baseUrl?: string): string {
    return buildHAUrl(path, baseUrl)
}

/** Fetch all Areas (Rooms) from HA */
export async function fetchHAAreas(url: string, token: string): Promise<HAArea[]> {
    logger.info(`fetchHAAreas: Requesting areas from ${url}`);

    const response = await fetchWithTimeout(getUrl('/api/template', url), {
        method: 'POST',
        headers: getHeaders(token),
        body: JSON.stringify({
            template: `
        {% set area_ns = namespace(items=[]) %}
        {% for area_id in areas() %}
            {% set area = area_id | area_name %}
            {% set area_ns.items = area_ns.items + [{ "area_id": area_id, "name": area }] %}
        {% endfor %}
        {{ area_ns.items | to_json }}
        `
        })
    })

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error(`fetchHAAreas: Failed ${response.status}`, errorText);
        throw new Error(`Failed to fetch areas: ${response.status}`);
    }

    const text = await response.text();
    const data = JSON.parse(text);
    logger.info(`fetchHAAreas: Received ${data.length} areas`);
    return data;
}

/**
 * Comprehensive Fetch that gets the State Machine and correlates it
 */
export async function fetchSmartHASync(url: string, token: string, connectionId?: string) {
    logger.info(`fetchSmartHASync: Requesting topology from ${url}`);

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

    const response = await fetchWithTimeout(getUrl('/api/template', url), {
        method: 'POST',
        headers: getHeaders(token),
        body: JSON.stringify({ template })
    }, 20000)

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error(`fetchSmartHASync: Failed ${response.status}`, errorText);
        throw new Error(`Failed to fetch sync data (${response.status})`);
    }

    const text = await response.text();
    logger.info(`fetchSmartHASync: Received topology (length: ${text.length})`);
    try {
        const parsed = JSON.parse(text);
        try {
            if (connectionId) {
                localStorage.setItem(`ha_topology_${connectionId}`, text);
            }
            localStorage.setItem('ha_topology_latest', text);
        } catch { }
        return parsed;
    } catch (e) {
        logger.error(`fetchSmartHASync: JSON Parse Error`, { error: e });
        throw e;
    }
}

/**
 * Rich REST Fallback via /api/template (2-Stage, 100% HA-version proof):
 * Stage 1 fetches Areas, Devices (name, manufacturer, model, area_id) and Entity->Device mapping
 * using ONLY universal HA Jinja functions (so it NEVER fails on HTTP 400 over local Wi-Fi).
 * Stage 2 optionally enriches integration `platform` names in a separate guarded call.
 */
export async function fetchRichHATopology(url: string, token: string, connectionId?: string): Promise<{
    areas: HAArea[];
    devices: Array<HADeviceRegistryEntry & { platform?: string; identifiers?: any[] }>;
    entities: HAEntityRegistryEntry[];
    topology: { floors: any[]; areas: Array<{ id: string; name: string; entities: string[] }>; orphans: string[] };
}> {
    logger.info(`fetchRichHATopology: Requesting core areas/devices/entities via REST template from ${url}`);

    // Stage 1: Ultra-safe, compact core template (only universal HA built-ins: areas, area_name, area_entities, device_id, area_id, device_attr)
    const coreTemplate = `
    {% set out_areas = namespace(items=[]) %}
    {% for aid in areas() %}
      {% set out_areas.items = out_areas.items + [{
        "id": aid,
        "nm": area_name(aid),
        "es": area_entities(aid) | list
      }] %}
    {% endfor %}

    {% set out_devices = namespace(seen=[], items=[]) %}
    {% set out_entities = namespace(items=[]) %}
    {% set out_orphans = namespace(items=[]) %}

    {% for s in states %}
      {% set eid = s.entity_id %}
      {% set did = device_id(eid) %}
      {% set aid = area_id(eid) %}

      {% if did and did not in out_devices.seen %}
        {% set out_devices.seen = out_devices.seen + [did] %}
        {% set out_devices.items = out_devices.items + [{
          "id": did,
          "ar": device_attr(did, 'area_id'),
          "nm": device_attr(did, 'name'),
          "nu": device_attr(did, 'name_by_user'),
          "mf": device_attr(did, 'manufacturer'),
          "md": device_attr(did, 'model')
        }] %}
      {% endif %}

      {% set out_entities.items = out_entities.items + [{
        "e": eid,
        "d": did,
        "a": aid,
        "n": s.name
      }] %}

      {% if aid == none %}
        {% set out_orphans.items = out_orphans.items + [eid] %}
      {% endif %}
    {% endfor %}

    {{ {
      "areas": out_areas.items,
      "devices": out_devices.items,
      "entities": out_entities.items,
      "orphans": out_orphans.items
    } | to_json }}
    `;

    const response = await fetchWithTimeout(getUrl('/api/template', url), {
        method: 'POST',
        headers: getHeaders(token),
        body: JSON.stringify({ template: coreTemplate })
    }, 25000);

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error(`fetchRichHATopology: Core template failed ${response.status}`, errorText);
        throw new Error(`Failed to fetch rich topology (${response.status})`);
    }

    const text = await response.text();
    const parsed = JSON.parse(text);

    // Stage 2: Best-effort platform/integration enrichment (never allowed to break Stage 1 device grouping!)
    const platformByDevice = new Map<string, string>();
    const platformByEntity = new Map<string, string>();
    try {
        const platTemplate = `
        {% set dp = namespace(items={}) %}
        {% set ep = namespace(items={}) %}
        {% set has_ce = (config_entry_id is defined and config_entry_attr is defined) %}
        {% for s in states %}
          {% set eid = s.entity_id %}
          {% set did = device_id(eid) %}
          {% set plat = '' %}
          {% if has_ce %}
            {% set cid = config_entry_id(eid) %}
            {% if cid is string %}
              {% set plat = config_entry_attr(cid, 'domain') or '' %}
            {% endif %}
          {% endif %}
          {% if not plat and did %}
            {% set idents = device_attr(did, 'identifiers') %}
            {% if idents %}
              {% for pair in idents %}
                {% if not plat and pair is iterable and pair is not string %}
                  {% set pair_list = pair | list %}
                  {% if pair_list | length > 0 %}
                    {% set plat = pair_list[0] | string %}
                  {% endif %}
                {% endif %}
              {% endfor %}
            {% endif %}
          {% endif %}
          {% if plat %}
            {% if did %}{% set dp.items = dict(dp.items, **{did: plat}) %}{% endif %}
            {% set ep.items = dict(ep.items, **{eid: plat}) %}
          {% endif %}
        {% endfor %}
        {{ {"dp": dp.items, "ep": ep.items} | to_json }}
        `;
        const platRes = await fetchWithTimeout(getUrl('/api/template', url), {
            method: 'POST',
            headers: getHeaders(token),
            body: JSON.stringify({ template: platTemplate })
        }, 15000);
        if (platRes.ok) {
            const platData = JSON.parse(await platRes.text());
            if (platData?.dp && typeof platData.dp === 'object') {
                Object.entries(platData.dp).forEach(([k, v]) => {
                    if (v) platformByDevice.set(k, String(v));
                });
            }
            if (platData?.ep && typeof platData.ep === 'object') {
                Object.entries(platData.ep).forEach(([k, v]) => {
                    if (v) platformByEntity.set(k, String(v));
                });
            }
        }
    } catch (platErr: any) {
        logger.warn('fetchRichHATopology: Optional platform enrichment skipped:', platErr?.message || platErr);
    }

    const areasList: HAArea[] = Array.isArray(parsed.areas)
        ? parsed.areas.map((a: any) => ({ area_id: a.id || a.area_id, name: a.nm || a.name || a.id }))
        : [];
    const devicesList: Array<HADeviceRegistryEntry & { platform?: string; identifiers?: any[] }> = Array.isArray(parsed.devices)
        ? parsed.devices.map((d: any) => ({
            id: d.id,
            area_id: d.ar ?? d.area_id ?? null,
            name: d.nm ?? d.name ?? null,
            name_by_user: d.nu ?? d.name_by_user ?? null,
            manufacturer: d.mf ?? d.manufacturer ?? null,
            model: d.md ?? d.model ?? null,
            platform: platformByDevice.get(d.id) || d.platform || undefined
        }))
        : [];
    const entitiesList: HAEntityRegistryEntry[] = Array.isArray(parsed.entities)
        ? parsed.entities.map((e: any) => {
            const eid = e.e || e.entity_id;
            const did = e.d ?? e.device_id ?? null;
            return {
                entity_id: eid,
                device_id: did,
                area_id: e.a ?? e.area_id ?? null,
                disabled_by: null,
                config_entry_id: null,
                name: e.n ?? e.name ?? null,
                original_name: e.n ?? e.original_name ?? eid,
                platform: platformByEntity.get(eid) || (did ? platformByDevice.get(did) : '') || e.platform || ''
            };
        })
        : [];

    const topology = {
        floors: [],
        areas: Array.isArray(parsed.areas)
            ? parsed.areas.map((a: any) => ({ id: a.id || a.area_id, name: a.nm || a.name || a.id, entities: a.es || a.entities || [] }))
            : [],
        orphans: Array.isArray(parsed.orphans) ? parsed.orphans : []
    };

    try {
        const serialized = JSON.stringify(topology);
        if (connectionId) {
            localStorage.setItem(`ha_topology_${connectionId}`, serialized);
            localStorage.setItem(`ha_registries_${connectionId}`, JSON.stringify({
                areas: areasList,
                devices: devicesList,
                entities: entitiesList,
                updatedAt: Date.now()
            }));
        }
        localStorage.setItem('ha_topology_latest', serialized);
    } catch { }

    logger.info(`✅ fetchRichHATopology: ${areasList.length} areas, ${devicesList.length} devices, ${entitiesList.length} entities (${platformByDevice.size} device platforms)`);
    return { areas: areasList, devices: devicesList, entities: entitiesList, topology };
}

/**
 * Orchestrator: Syncs Home Assistant areas and entities to Dashboard tiles & Supabase rooms
 */
export async function processHASync(
    connectionId: string,
    apiUrl: string,
    apiToken: string,
    _userId?: string
) {
    logger.info('processHASync: Starting Sync...', { connectionId, apiUrl });
    let topology: { areas: any[], orphans: any[] } = { areas: [], orphans: [] }
    let richDevicesById = new Map<string, any>()
    let richEntitiesById = new Map<string, any>()
    let useFallback = false

    try {
        const rich = await fetchRichHATopology(apiUrl, apiToken, connectionId)
        topology = rich.topology
        rich.devices.forEach(d => { if (d?.id) richDevicesById.set(d.id, d) })
        rich.entities.forEach(e => { if (e?.entity_id) richEntitiesById.set(e.entity_id, e) })
        logger.info('processHASync: Rich topology fetched', {
            areaCount: topology.areas?.length,
            deviceCount: rich.devices.length,
            entityCount: rich.entities.length
        });

        if ((!topology.areas || topology.areas.length === 0) && (!topology.orphans || topology.orphans.length === 0)) {
            logger.warn('processHASync: Rich topology empty, trying basic Smart Sync');
            topology = await fetchSmartHASync(apiUrl, apiToken, connectionId)
        }
        if ((!topology.areas || topology.areas.length === 0) && (!topology.orphans || topology.orphans.length === 0)) {
            useFallback = true
        }
    } catch (err) {
        logger.warn('processHASync: Rich topology failed, trying basic Smart Sync fallback', err);
        try {
            topology = await fetchSmartHASync(apiUrl, apiToken, connectionId)
            if ((!topology.areas || topology.areas.length === 0) && (!topology.orphans || topology.orphans.length === 0)) {
                useFallback = true
            }
        } catch (err2) {
            logger.error('processHASync: Smart Sync Failed, switching to Fallback Mode', err2);
            useFallback = true
        }
    }

    // 2. Fetch States (for details)
    logger.info('processHASync: Fetching States...');
    const statesResponse = await fetchWithTimeout(getUrl('/api/states', apiUrl), {
        headers: getHeaders(apiToken)
    }, 20000)
    if (!statesResponse.ok) {
        const errText = await statesResponse.text().catch(() => '');
        logger.error(`processHASync: Fetch States Failed ${statesResponse.status}`, errText);
        throw new Error(`Failed to fetch states (${statesResponse.status})`);
    }

    const states: any[] = await statesResponse.json()
    logger.info(`processHASync: Received ${states.length} states`);
    const stateMap = new Map(states.map(s => [s.entity_id, s]))

    // 3. Build Tiles matching Dashboard.tsx DashboardTile / DeviceGroup schema (GROUPED BY DEVICE!)
    const tiles: any[] = []

    const IGNORED_SYSTEM_DOMAINS = new Set(['sun', 'zone', 'update', 'tts', 'stt', 'conversation', 'persistent_notification'])

    const getDeviceType = (domain: string): string | null => {
        if (IGNORED_SYSTEM_DOMAINS.has(domain)) return null
        const types: Record<string, string> = {
            light: 'light',
            switch: 'switch',
            media_player: 'media',
            climate: 'climate',
            water_heater: 'water_heater',
            humidifier: 'humidifier',
            fan: 'fan',
            cover: 'cover',
            lock: 'lock',
            valve: 'valve',
            alarm_control_panel: 'alarm_control_panel',
            siren: 'siren',
            vacuum: 'vacuum',
            lawn_mower: 'lawn_mower',
            remote: 'remote',
            button: 'button',
            input_button: 'input_button',
            select: 'select',
            input_select: 'input_select',
            number: 'number',
            input_number: 'input_number',
            input_boolean: 'input_boolean',
            input_text: 'input_text',
            input_datetime: 'input_datetime',
            sensor: 'sensor',
            binary_sensor: 'binary_sensor',
            camera: 'camera',
            scene: 'scene',
            script: 'script',
            automation: 'automation',
            todo: 'todo',
            calendar: 'calendar',
            weather: 'weather',
            person: 'person',
            device_tracker: 'device_tracker',
            timer: 'timer',
            counter: 'counter',
            event: 'event',
            image: 'image'
        }
        return types[domain] || 'sensor'
    }

    const getIcon = (domain: string): string => {
        const icons: Record<string, string> = {
            light: '💡',
            switch: '🔌',
            media_player: '📺',
            climate: '🌡️',
            water_heater: '🔥',
            humidifier: '💧',
            fan: '🌀',
            cover: '🪟',
            lock: '🔒',
            valve: '🚰',
            alarm_control_panel: '🛡️',
            siren: '🚨',
            vacuum: '🧹',
            lawn_mower: '🌿',
            remote: '📱',
            button: '🔘',
            input_button: '🔘',
            select: '🎛️',
            input_select: '🎛️',
            number: '🎚️',
            input_number: '🎚️',
            input_boolean: '🔘',
            input_text: '📝',
            input_datetime: '🕒',
            sensor: '👁️',
            binary_sensor: '📡',
            camera: '📷',
            scene: '✨',
            script: '⚡',
            automation: '🤖',
            todo: '✅',
            calendar: '📅',
            weather: '🌤️',
            person: '👤',
            device_tracker: '📍',
            timer: '⏱️',
            counter: '🔢',
            event: '⚡',
            image: '🖼️'
        }
        return icons[domain] || '📦'
    }

    const processEntityList = (entityIds: string[] | undefined | null, areaId?: string): any[] => {
        if (!Array.isArray(entityIds)) return []
        const byDeviceId = new Map<string, any>()
        const ungrouped: any[] = []

        for (const entityId of entityIds) {
            const stateObj = stateMap.get(entityId)
            if (!stateObj) continue
            const domain = entityId.split('.')[0]
            const type = getDeviceType(domain)
            if (!type) continue

            const reg = richEntitiesById.get(entityId)
            const devId = reg?.device_id || null
            const haDev = devId ? richDevicesById.get(devId) : null
            const friendlyName = reg?.name || stateObj.attributes?.friendly_name || entityId
            const resolvedPlatform = reg?.platform || haDev?.platform || undefined

            const roomEnt = {
                id: `ent-${entityId}`,
                type,
                name: friendlyName,
                icon: getIcon(domain),
                entityId,
                deviceId: devId || undefined,
                platform: resolvedPlatform
            }

            if (devId) {
                if (!byDeviceId.has(devId)) {
                    byDeviceId.set(devId, {
                        id: devId,
                        name: haDev?.name_by_user || haDev?.name || friendlyName,
                        manufacturer: haDev?.manufacturer || undefined,
                        model: haDev?.model || undefined,
                        platform: resolvedPlatform,
                        areaId: haDev?.area_id || areaId,
                        primaryEntity: roomEnt,
                        entities: []
                    })
                }
                const grp = byDeviceId.get(devId)!
                grp.entities.push(roomEnt)
            } else {
                ungrouped.push({
                    id: `orp-${entityId}`,
                    name: friendlyName,
                    platform: resolvedPlatform,
                    areaId,
                    primaryEntity: roomEnt,
                    entities: [roomEnt]
                })
            }
        }

        return [...Array.from(byDeviceId.values()), ...ungrouped]
    }

    if (useFallback) {
        const allEntityIds = states.map(s => s.entity_id)
        const allGroups = processEntityList(allEntityIds, 'all')

        if (allGroups.length > 0) {
            tiles.push({
                id: 'room-all',
                type: 'room',
                roomId: 'all',
                roomName: 'Alle apparaten',
                roomIcon: '🏠',
                order: 0,
                deviceGroups: allGroups
            })
        }
    } else {
        for (const area of (topology.areas || [])) {
            if (!area?.name) continue

            const tileId = area.id
            const deviceGroups = processEntityList(area.entities, area.id)

            tiles.push({
                id: tileId,
                type: 'room',
                roomId: area.id,
                roomName: area.name,
                roomIcon: 'not_found',
                order: tiles.length,
                deviceGroups
            })
        }

        if (Array.isArray(topology.orphans) && topology.orphans.length > 0) {
            const orphanGroups = processEntityList(topology.orphans, 'unassigned')
            const unassignedGroups: any[] = []

            for (const grp of orphanGroups) {
                const dev = grp.primaryEntity
                const searchStr = `${dev.entityId} ${grp.name}`.toLowerCase()
                let matched = false

                for (const tile of tiles) {
                    const areaNameLower = (tile.roomName || '').toLowerCase().trim()
                    if (areaNameLower.length < 3) continue
                    const escaped = areaNameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    const boundaryRe = new RegExp(`(^|[\\s_.-])${escaped}($|[\\s_.-])`, 'i')
                    if (boundaryRe.test(searchStr)) {
                        grp.areaId = tile.roomId
                        tile.deviceGroups.push(grp)
                        matched = true
                        break
                    }
                }

                if (!matched) {
                    unassignedGroups.push(grp)
                }
            }

            if (unassignedGroups.length > 0) {
                tiles.push({
                    id: 'unassigned',
                    type: 'room',
                    roomId: 'unassigned',
                    roomName: 'Overige Apparaten',
                    roomIcon: '📦',
                    order: tiles.length,
                    deviceGroups: unassignedGroups
                })
            }
        }
    }

    tiles.forEach(t => {
        if (t.roomIcon && t.roomIcon !== 'not_found') return
        const lower = (t.roomName || '').toLowerCase()
        if (lower.includes('bed') || lower.includes('slaap')) t.roomIcon = '🛏️'
        else if (lower.includes('living') || lower.includes('woon') || lower.includes('salon')) t.roomIcon = '🛋️'
        else if (lower.includes('kitchen') || lower.includes('keuken') || lower.includes('kook')) t.roomIcon = '🍳'
        else if (lower.includes('bath') || lower.includes('bad') || lower.includes('douche')) t.roomIcon = '🚿'
        else if (lower.includes('office') || lower.includes('study') || lower.includes('bureau') || lower.includes('kantoor')) t.roomIcon = '💻'
        else if (lower.includes('garage') || lower.includes('oprit') || lower.includes('carport')) t.roomIcon = '🚗'
        else if (lower.includes('garden') || lower.includes('tuin') || lower.includes('terras') || lower.includes('buiten')) t.roomIcon = '🌱'
        else if (lower.includes('gang') || lower.includes('hall') || lower.includes('inkom')) t.roomIcon = '🚪'
        else if (lower.includes('was') || lower.includes('berg') || lower.includes('kelder') || lower.includes('zolder')) t.roomIcon = '🧺'
        else if (lower.includes('energie') || lower.includes('energy') || lower.includes('meter') || lower.includes('solar')) t.roomIcon = '⚡'
        else if (lower.includes('beveilig') || lower.includes('alarm') || lower.includes('camera')) t.roomIcon = '🛡️'
        else t.roomIcon = '🏠'
    })

    // 4. Save to LocalStorage (scoped strictly to connectionId)
    const totalDevices = tiles.reduce((acc, t) => acc + (t.deviceGroups?.length || 0), 0)
    logger.info(`processHASync: Generating ${tiles.length} tiles (Total device groups: ${totalDevices})`)
    try {
        localStorage.setItem(`dashboard_tiles_${connectionId}`, JSON.stringify(tiles))
    } catch (storageErr) {
        logger.warn('processHASync: localStorage quota exceeded while saving tiles', storageErr)
    }

    // 5. Sync to Supabase (Rooms) - only insert if delete succeeded
    logger.info('processHASync: Syncing rooms to Supabase...')
    const { error: delError } = await supabase
        .from('rooms')
        .delete()
        .eq('connection_id', connectionId)

    if (delError) {
        logger.error('processHASync: Error clearing rooms (skipping insert to avoid duplicates)', delError)
    } else {
        const roomRows = tiles
            .filter(t => t.roomId !== 'unassigned' && t.roomId !== 'all')
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
            else logger.info('processHASync: Rooms synced successfully')
        }
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

const STRICT_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/** 1. Fetch History and compute statistical summary */
export async function fetchHAHistory(
    apiUrl: string,
    apiToken: string,
    entityId: string,
    hoursAgo: number = 24
) {
    const safeHours = Math.max(1, Math.min(hoursAgo || 24, 24 * 30));
    const startTimeIso = new Date(Date.now() - safeHours * 3600 * 1000).toISOString();
    const url = `${getUrl(`/api/history/period/${encodeURIComponent(startTimeIso)}`, apiUrl)}?filter_entity_id=${encodeURIComponent(entityId)}&minimal_response=1`;
    logger.info(`fetchHAHistory: Requesting history for ${entityId} (${safeHours}h ago)`);

    const res = await fetchWithTimeout(url, { headers: getHeaders(apiToken) }, 20000);
    if (!res.ok) {
        throw new Error(`HA History fetch failed with status ${res.status}`);
    }

    const data: any[][] = await res.json();
    if (!data || data.length === 0 || !data[0] || data[0].length === 0) {
        return { entity_id: entityId, message: 'Geen historische data gevonden voor deze periode.' };
    }

    const points = data[0];
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];

    const validNums: Array<{ val: number; time: string }> = [];
    for (const p of points) {
        const s = typeof p.state === 'string' ? p.state.trim() : String(p.state ?? '');
        if (STRICT_NUMBER_RE.test(s)) {
            const val = Number(s);
            if (Number.isFinite(val)) {
                validNums.push({ val, time: p.last_changed || p.last_updated || '' });
            }
        }
    }

    // With minimal_response=1, HA only includes attributes on points[0]
    const unit = firstPoint?.attributes?.unit_of_measurement ?? lastPoint?.attributes?.unit_of_measurement ?? null;

    if (validNums.length > 0) {
        let minVal = Infinity;
        let maxVal = -Infinity;
        let sumVal = 0;
        for (const item of validNums) {
            if (item.val < minVal) minVal = item.val;
            if (item.val > maxVal) maxVal = item.val;
            sumVal += item.val;
        }
        const avgVal = sumVal / validNums.length;
        const startVal = validNums[0].val;
        const endVal = validNums[validNums.length - 1].val;
        const change = endVal - startVal;

        return {
            entity_id: entityId,
            period_hours: safeHours,
            start_time: firstPoint.last_changed || firstPoint.last_updated || null,
            end_time: lastPoint.last_changed || lastPoint.last_updated || null,
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
            unit
        };
    }

    const transitions = points.slice(-10).map(p => {
        const ts = p.last_changed || p.last_updated;
        const d = ts ? new Date(ts) : null;
        return {
            state: p.state,
            time: d && !isNaN(d.getTime())
                ? d.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })
                : 'onbekend'
        };
    });

    return {
        entity_id: entityId,
        period_hours: safeHours,
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
    const safeHours = Math.max(1, Math.min(hoursAgo || 24, 24 * 14));
    const startTimeIso = new Date(Date.now() - safeHours * 3600 * 1000).toISOString();
    let url = `${getUrl(`/api/logbook/${encodeURIComponent(startTimeIso)}`, apiUrl)}`;
    if (entityId) {
        url += `?entity=${encodeURIComponent(entityId)}`;
    }
    logger.info(`fetchHALogbook: Requesting logbook (${safeHours}h ago)${entityId ? ` for ${entityId}` : ''}`);

    const res = await fetchWithTimeout(url, { headers: getHeaders(apiToken) }, 20000);
    if (!res.ok) {
        throw new Error(`HA Logbook fetch failed with status ${res.status}`);
    }

    const events: any[] = await res.json();
    if (!Array.isArray(events) || events.length === 0) {
        return { message: 'Geen logboekgebeurtenissen gevonden voor deze periode.', events: [] };
    }

    const formatted = events.slice(-30).reverse().map(e => {
        const d = e.when ? new Date(e.when) : null;
        return {
            time: d && !isNaN(d.getTime()) ? d.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : e.when,
            date: d && !isNaN(d.getTime()) ? d.toLocaleDateString('nl-BE') : '',
            entity_id: e.entity_id,
            name: e.name,
            message: e.message,
            state: e.state
        };
    });

    return {
        total_events: events.length,
        period_hours: safeHours,
        events: formatted
    };
}

/** 3. Fetch Camera Snapshot as Base64 Image */
export async function fetchHACameraSnapshot(
    apiUrl: string,
    apiToken: string,
    cameraEntityId: string
): Promise<{ base64: string; dataUrl: string; mimeType: string; entity_id: string }> {
    const url = getUrl(`/api/camera_proxy/${encodeURIComponent(cameraEntityId)}`, apiUrl);
    logger.info(`fetchHACameraSnapshot: Fetching snapshot from ${cameraEntityId}`);

    const res = await fetchWithTimeout(url, { headers: getHeaders(apiToken, false) }, 15000);
    if (!res.ok) {
        throw new Error(`Failed to fetch camera snapshot (${res.status})`);
    }

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const mimeType = contentType.split(';')[0].trim() || 'image/jpeg';
    const buffer = await res.arrayBuffer();
    const base64 = bufferToBase64(buffer);
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
        base64,
        dataUrl,
        mimeType,
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

    let targetListId = listEntityId;
    if (!targetListId) {
        const statesRes = await fetchWithTimeout(getUrl('/api/states', apiUrl), { headers: getHeaders(apiToken) });
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

    // Modern HA returns { changed_states: [...], service_response: { [entity_id]: { items: [...] } } }
    const serviceUrl = getUrl('/api/services/todo/get_items?return_response=1', apiUrl);
    try {
        const res = await fetchWithTimeout(serviceUrl, {
            method: 'POST',
            headers: getHeaders(apiToken),
            body: JSON.stringify({ entity_id: targetListId })
        });
        if (res.ok) {
            const data = await res.json();
            const items =
                data?.service_response?.[targetListId]?.items ||
                data?.[targetListId]?.items ||
                [];
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

    const stateRes = await fetchWithTimeout(getUrl(`/api/states/${encodeURIComponent(targetListId)}`, apiUrl), { headers: getHeaders(apiToken) });
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
    action: 'add' | 'update' | 'complete' | 'remove',
    params: { listEntityId: string; item: string; status?: 'needs_action' | 'completed' }
) {
    const { listEntityId, item, status } = params;
    let service = 'add_item';
    let serviceData: Record<string, any> = { entity_id: listEntityId, item };

    if (action === 'update' || action === 'complete') {
        service = 'update_item';
        serviceData = {
            entity_id: listEntityId,
            item,
            status: action === 'complete' ? 'completed' : (status || 'completed')
        };
    } else if (action === 'remove') {
        service = 'remove_item';
        // HA todo.remove_item expects a single string summary/UID
        serviceData = { entity_id: listEntityId, item };
    }

    const { callHAService } = await import('./home-assistant');
    await callHAService('todo', service, serviceData, apiUrl, apiToken);
    const verb =
        action === 'add' ? 'toegevoegd aan'
            : action === 'complete' ? 'afgevinkt in'
                : action === 'update' ? 'bijgewerkt in'
                    : 'verwijderd uit';
    return {
        success: true,
        action,
        item,
        list_entity_id: listEntityId,
        message: `Item "${item}" ${verb} ${listEntityId}.`
    };
}

/** 6. Fetch Calendar Events across a specific calendar or ALL HA calendars */
export async function fetchHACalendarEvents(
    apiUrl: string,
    apiToken: string,
    calendarEntityId?: string,
    daysAhead: number = 7
) {
    const safeDays = Math.max(1, Math.min(daysAhead || 7, 90));
    logger.info(`fetchHACalendarEvents: Fetching calendar events (${safeDays} days ahead)`);

    let targetCalendars: Array<{ entity_id: string; name?: string }> = [];

    if (calendarEntityId) {
        targetCalendars = [{ entity_id: calendarEntityId }];
    } else {
        const calsRes = await fetchWithTimeout(getUrl('/api/calendars', apiUrl), { headers: getHeaders(apiToken) });
        if (calsRes.ok) {
            const cals: any[] = await calsRes.json();
            if (Array.isArray(cals)) {
                targetCalendars = cals.map(c => ({ entity_id: c.entity_id, name: c.name }));
            }
        }
    }

    if (targetCalendars.length === 0) {
        return { message: 'Geen actieve kalender gevonden in Home Assistant.', events: [] };
    }

    const startIso = new Date().toISOString();
    const endIso = new Date(Date.now() + safeDays * 24 * 3600 * 1000).toISOString();

    const perCalendarResults = await Promise.all(
        targetCalendars.map(async (cal) => {
            try {
                const eventsUrl = `${getUrl(`/api/calendars/${encodeURIComponent(cal.entity_id)}`, apiUrl)}?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
                const res = await fetchWithTimeout(eventsUrl, { headers: getHeaders(apiToken) });
                if (!res.ok) return [];
                const events: any[] = await res.json();
                if (!Array.isArray(events)) return [];
                return events.map(ev => ({
                    calendar: cal.name || cal.entity_id,
                    calendar_entity_id: cal.entity_id,
                    summary: ev.summary,
                    start: ev.start?.dateTime || ev.start?.date || ev.start,
                    end: ev.end?.dateTime || ev.end?.date || ev.end,
                    description: ev.description || null,
                    location: ev.location || null
                }));
            } catch {
                return [];
            }
        })
    );

    const mergedEvents = perCalendarResults
        .flat()
        .sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime());

    return {
        calendar_entity_id: targetCalendars.length === 1 ? targetCalendars[0].entity_id : targetCalendars.map(c => c.entity_id).join(', '),
        calendars_checked: targetCalendars.map(c => c.entity_id),
        period_days: safeDays,
        total_events: mergedEvents.length,
        events: mergedEvents
    };
}

/** 7. Save and reload Home Assistant Automation (strips non-HA metadata keys) */
export async function saveHAAutomation(
    apiUrl: string,
    apiToken: string,
    automationConfig: { id?: string; alias: string; description?: string; trigger: any[]; condition?: any[]; action: any[]; mode?: string; [key: string]: any }
) {
    const autoId = automationConfig.id || `butler_auto_${Date.now()}`;

    // Strip non-HA metadata fields (ready_for_user_review, message, etc.) so Voluptuous never returns HTTP 400
    const payload: Record<string, any> = {
        id: autoId,
        alias: automationConfig.alias || 'Butler Automatisering',
        description: automationConfig.description || '',
        trigger: Array.isArray(automationConfig.trigger) ? automationConfig.trigger : [automationConfig.trigger].filter(Boolean),
        condition: Array.isArray(automationConfig.condition) ? automationConfig.condition : [],
        action: Array.isArray(automationConfig.action) ? automationConfig.action : [automationConfig.action].filter(Boolean),
        mode: automationConfig.mode || 'single'
    };

    logger.info(`saveHAAutomation: Creating automation ${autoId} (${payload.alias})`);
    const saveUrl = getUrl(`/api/config/automation/config/${encodeURIComponent(autoId)}`, apiUrl);
    const res = await fetchWithTimeout(saveUrl, {
        method: 'POST',
        headers: getHeaders(apiToken),
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`Opslaan van automatisering mislukt (${res.status}): ${err}`);
    }

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
