
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

/** Fetch all Areas (Rooms) from HA */
export async function fetchHAAreas(url: string, token: string): Promise<HAArea[]> {
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
    })

    if (!response.ok) throw new Error(`Failed to fetch areas: ${response.status}`)
    // Template returns a string, we need to parse it if it's double encoded or just return it?
    // Usually template rendering returns the string representation.
    // However, for complex objects, we might use the Websocket API later.
    // For now simpler approach: Use the WS API wrapper for REST if possible or just use a simpler list.
    // Actually, getting areas via REST API is easiest via the template: `{{ areas() | list | to_json }}` is IDs, but we want objects.
    // Let's optimize: The websocket API is better for registries. But to keep it simple locally without WS refactor yet:

    // Better strategy: Use the specialized /api/config/area_registry/list endpoint if available (admin only usually). 
    // Standard user safe way: Render template.
    return response.json()
}

/** 
 * Comprehensive Fetch that gets the State Machine and correlates it 
 * Since we can't easily access the Private Registries via REST without Admin, 
 * we will infer structure from the State Object attributes combined with a smart template.
 */
export async function fetchSmartHASync(url: string, token: string) {
    // This template attempts to group entities by area
    // It is a powerful Jinja2 template to extract the graph
    const template = `
    {
      "areas": [
        {% for area_id in areas() %}
          {
            "id": "{{ area_id }}",
            "name": "{{ area_name(area_id) }}",
            "entities": [
              {% for entity in area_entities(area_id) %}
                "{{ entity }}"{{ "," if not loop.last }}
              {% endfor %}
            ]
          }{{ "," if not loop.last }}
        {% endfor %}
      ],
      "orphans": [
         {% for state in states if state.entity_id not in area_entities(area_id(state.entity_id)) and area_id(state.entity_id) == none %}
             "{{ state.entity_id }}"{{ "," if not loop.last }}
         {% endfor %}
      ]
    }
    `

    const response = await fetch(getUrl('/api/template', url), {
        method: 'POST',
        headers: getHeaders(token),
        body: JSON.stringify({ template })
    })

    if (!response.ok) throw new Error('Failed to fetch sync data')
    // HA returns the rendered string, which is JSON
    const text = await response.text()
    return JSON.parse(text)
}

/** 
 * Orchestrator:
 * 1. Fetch smart group data
 * 2. Fetch all current states (for attributes like friendly_name, device_class)
 * 3. Build UI Dashboard Tiles + Devices
 * 4. Sync to Supabase
 */
export async function processHASync(
    connectionId: string,
    apiUrl: string,
    apiToken: string,
    userId: string
) {
    // 1. Fetch Topology
    let topology: { areas: any[], orphans: any[] } = { areas: [], orphans: [] }
    let useFallback = false

    try {
        console.log('🔄 Fetching Smart Topology...')
        topology = await fetchSmartHASync(apiUrl, apiToken)
        console.log('✅ Topology:', topology)
        if ((!topology.areas || topology.areas.length === 0) && (!topology.orphans || topology.orphans.length === 0)) {
            console.warn('⚠️ Topology empty, switching to Fallback Mode')
            useFallback = true
        }
    } catch (err) {
        console.error('❌ Smart Sync Failed, switching to Fallback Mode', err)
        useFallback = true
    }

    // 2. Fetch States (for details)
    console.log('🔄 Fetching States...')
    const statesResponse = await fetch(getUrl('/api/states', apiUrl), {
        headers: getHeaders(apiToken)
    })
    if (!statesResponse.ok) throw new Error('Failed to fetch states') // Critical failure if this fails

    const states: any[] = await statesResponse.json()
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

        // Process Orphans -> Unassigned Room
        if (topology.orphans && topology.orphans.length > 0) {
            const orphanDevices = processEntityList(topology.orphans)

            if (orphanDevices.length > 0) {
                tiles.push({
                    id: 'room-unassigned',
                    type: 'room',
                    roomId: 'unassigned', // Special ID
                    roomName: 'Unassigned',
                    roomIcon: '📦',
                    order: tiles.length,
                    devices: orphanDevices
                })
            }
        }
    }

    // Update icons for known room names
    tiles.forEach(t => {
        if (t.roomId === 'unassigned' || t.roomId === 'all') return // Skip icon logic for unassigned or all
        const lower = t.roomName.toLowerCase()
        if (lower.includes('bed')) t.roomIcon = '🛏️'
        else if (lower.includes('living')) t.roomIcon = '🛋️'
        else if (lower.includes('kitchen')) t.roomIcon = '🍳'
        else if (lower.includes('bath')) t.roomIcon = '🚿'
        else if (lower.includes('office') || lower.includes('study')) t.roomIcon = '💻'
        else if (lower.includes('garage')) t.roomIcon = '🚗'
        else if (lower.includes('garden')) t.roomIcon = '🌱'
        else t.roomIcon = '🏠'
    })

    // 4. Save to LocalStorage (Dashboard)
    console.log('💾 Saving Tiles:', tiles.length)
    // We MERGE or REPLACE? The prompt says "pull all... after first connection".
    // Replacing is safer for a "Setup" flow.
    localStorage.setItem('dashboard-tiles', JSON.stringify(tiles))

    // 5. Sync to Supabase (Rooms)
    // First, clear existing rooms for this connection to avoid duplicates?
    // or Upsert. Let's Delete old ones for this connection to be clean.
    const { error: delError } = await supabase
        .from('rooms')
        .delete()
        .eq('connection_id', connectionId)

    if (delError) console.error('Error clearing rooms', delError)

    // Prepare batch insert
    const roomRows = tiles.map(t => ({
        connection_id: connectionId,
        name: t.roomName,
        description: `Imported from Home Assistant Area: ${t.roomId}`,
        // We could store more dict data if the table supported it, 
        // but 'description' is a good place for metadata if needed.
    }))

    if (roomRows.length > 0) {
        const { error: insError } = await supabase
            .from('rooms')
            .insert(roomRows)
        if (insError) console.error('Error syncing rooms to Supabase', insError)
    }

    return tiles
}
