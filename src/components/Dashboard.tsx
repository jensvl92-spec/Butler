import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { useApp } from '../lib/AppContext'
import { logger } from '../utils/logger'
import { callHAService } from '../utils/home-assistant'
import { saveHAAutomation } from '../utils/ha-api'
import './Dashboard.css' // Import new styles
import { SuggestionPopup } from './SuggestionPopup'
import { Suggestion } from '../types'
import { supabase } from '../lib/supabase'


// Ref type for parent components to call import function
export interface DashboardRef {
    importLayoutFromHA: () => void
}

interface RoomDevice {
    id: string
    type: string
    name: string
    icon: string
    entityId?: string
    deviceId?: string
    // Added for detailed matching
    isDiagnostic?: boolean
}

// NEW: Device Group (The actual "Device" in HA terms)
interface DeviceGroup {
    id: string
    name: string
    manufacturer?: string
    model?: string
    areaId?: string
    primaryEntity?: RoomDevice // The "Main" control
    entities: RoomDevice[]
}

interface DashboardTile {
    id: string
    type: 'room' | 'add'
    roomId?: string
    roomName?: string
    roomIcon?: string
    order: number
    // CHANGE: Now holds DeviceGroups instead of flat Entities
    deviceGroups: DeviceGroup[]
}

function normalizeStoredTiles(raw: any): DashboardTile[] {
    if (!Array.isArray(raw)) return []
    return raw.map((tile: any, idx: number) => {
        if (Array.isArray(tile?.deviceGroups)) {
            return { ...tile, order: typeof tile.order === 'number' ? tile.order : idx }
        }
        // Gracefully migrate legacy flat `tile.devices` into `deviceGroups`
        const legacyDevices: RoomDevice[] = Array.isArray(tile?.devices) ? tile.devices : []
        const deviceGroups: DeviceGroup[] = legacyDevices.map((d) => ({
            id: `legacy-${d.id || d.entityId || Math.random().toString(36).slice(2)}`,
            name: d.name || d.entityId || 'Device',
            primaryEntity: d,
            entities: [d]
        }))
        return {
            id: tile?.id || `room-${idx}`,
            type: tile?.type === 'add' ? 'add' : 'room',
            roomId: tile?.roomId,
            roomName: tile?.roomName || 'Room',
            roomIcon: tile?.roomIcon || '🏠',
            order: typeof tile?.order === 'number' ? tile.order : idx,
            deviceGroups
        }
    })
}

const DEFAULT_TILES: DashboardTile[] = []

const ROOM_ICONS: Record<string, string> = {
    bedroom: '🛏️', slaapkamer: '🛏️',
    living: '🛋️', woonkamer: '🛋️', salon: '🛋️',
    kitchen: '🍳', keuken: '🍳',
    bathroom: '🚿', badkamer: '🚿',
    office: '💻', bureau: '💻', kantoor: '💻',
    garage: '🚗',
    garden: '🌱', tuin: '🌱',
    laundry: '🧺', wasplaats: '🧺', berging: '🧺', bijkeuken: '🧺',
    hall: '🚪', hal: '🚪', inkom: '🚪', gang: '🚪',
    attic: '🏠', zolder: '🏠', kelder: '🏚️',
    default: '🏠'
}

const DEVICE_TYPES = [
    { id: 'light', name: 'Light', icon: '💡', description: 'Control lights and brightness', domain: 'light' },
    { id: 'switch', name: 'Switch', icon: '🔌', description: 'Toggle switches on/off', domain: 'switch' },
    { id: 'climate', name: 'Climate', icon: '🌡️', description: 'Temperature and AC control', domain: 'climate' },
    { id: 'media', name: 'Media', icon: '📺', description: 'TV and media players', domain: 'media_player' },
    { id: 'cover', name: 'Blinds/Cover', icon: '🪟', description: 'Curtains and blinds', domain: 'cover' },
    { id: 'lock', name: 'Lock', icon: '🔒', description: 'Smart locks', domain: 'lock' },
    { id: 'fan', name: 'Fan', icon: '🌀', description: 'Fans and ventilation', domain: 'fan' },
    { id: 'vacuum', name: 'Vacuum', icon: '🤖', description: 'Robot vacuums', domain: 'vacuum' },
    { id: 'camera', name: 'Camera', icon: '📷', description: 'Security cameras', domain: 'camera' },
    { id: 'button', name: 'Button', icon: '🔘', description: 'Action buttons', domain: 'button' },
    { id: 'select', name: 'Select', icon: '🎛️', description: 'Mode & program selectors', domain: 'select' },
    { id: 'number', name: 'Number', icon: '🎚️', description: 'Numeric controls', domain: 'number' },
    { id: 'input_boolean', name: 'Toggle', icon: '🔘', description: 'Helper toggles', domain: 'input_boolean' },
    { id: 'water_heater', name: 'Boiler', icon: '🔥', description: 'Water heaters', domain: 'water_heater' },
    { id: 'humidifier', name: 'Humidifier', icon: '💧', description: 'Humidifiers', domain: 'humidifier' },
    { id: 'scene', name: 'Scene', icon: '✨', description: 'Scenes', domain: 'scene' },
    { id: 'script', name: 'Script', icon: '⚡', description: 'Scripts', domain: 'script' },
    { id: 'binary_sensor', name: 'Binary Sensor', icon: '📡', description: 'Status & contact sensors', domain: 'binary_sensor' },
    { id: 'sensor', name: 'Sensor', icon: '👁️', description: 'Read-only sensors', domain: 'sensor' },
]

function getApplianceIcon(name: string, fallbackIcon: string): string {
    const n = (name || '').toLowerCase()
    if (n.includes('wasmachine') || n.includes('washer') || n.includes('washing')) return '🫧'
    if (n.includes('droogkast') || n.includes('droger') || n.includes('dryer') || n.includes('tumble')) return '💨'
    if (n.includes('vaatwasser') || n.includes('dishwasher')) return '🍽️'
    if (n.includes('koelkast') || n.includes('fridge') || n.includes('vriezer') || n.includes('freezer')) return '🧊'
    if (n.includes('oven') || n.includes('kookplaat') || n.includes('fornuis')) return '🔥'
    if (n.includes('laadpaal') || n.includes('charger') || n.includes('wallbox') || n.includes('ev ')) return '🔋'
    if (n.includes('zonnepanelen') || n.includes('solar') || n.includes('omvormer') || n.includes('inverter')) return '☀️'
    return fallbackIcon
}

export const Dashboard = forwardRef<DashboardRef>((_props, ref) => {
    const { activeConnection, entityStates, haWebSocket, rooms, haAreas, haDevices, haEntitiesRegistry } = useApp()

    // State
    const [tiles, setTiles] = useState<DashboardTile[]>(DEFAULT_TILES)
    const [editMode] = useState(false)
    const [showAddRoomModal, setShowAddRoomModal] = useState(false)
    const [newRoomName, setNewRoomName] = useState('')
    const [searchQuery, setSearchQuery] = useState('')
    const [isSyncingLayout, setIsSyncingLayout] = useState(false)

    const [toastMsg, setToastMsg] = useState<string | null>(null)
    const [configTileId, setConfigTileId] = useState<string | null>(null)
    const [showDevicePicker, setShowDevicePicker] = useState(false)
    const [editingDevice, setEditingDevice] = useState<RoomDevice | null>(null)
    const [selectedEntityId, setSelectedEntityId] = useState('')

    // Detail Modal State
    const [detailTileId, setDetailTileId] = useState<string | null>(null)

    const [inspectorData, setInspectorData] = useState<{ name: string, diagnostics: RoomDevice[] } | null>(null)

    // Suggestion State
    const [headerSuggestions, setHeaderSuggestions] = useState<Suggestion[]>([])

    // Track which connection's tiles are currently loaded to prevent cross-connection overwrite on switch
    const loadedConnectionIdRef = useRef<string | null>(null)
    const autoImportedConnRef = useRef<string | null>(null)

    // Derived State
    const availableEntities = Object.entries(entityStates).map(([id, state]) => ({
        entity_id: id,
        state: state.state,
        attributes: state.attributes,
        friendly_name: state.attributes?.friendly_name || id
    }))

    // Load tiles on mount and Sync with DB Rooms
    useEffect(() => {
        if (!activeConnection?.id) {
            loadedConnectionIdRef.current = null
            setTiles([])
            return
        }

        const stored = localStorage.getItem(`dashboard_tiles_${activeConnection.id}`)
        let localTiles: DashboardTile[] = []
        if (stored) {
            try {
                localTiles = normalizeStoredTiles(JSON.parse(stored))
            } catch (e) {
                logger.warn('[Dashboard] Corrupted localStorage tiles, resetting', e)
                localTiles = []
            }
        }

        if (rooms.length > 0) {
            const mergedTiles = [...localTiles]
            let changed = false

            rooms.forEach(dbRoom => {
                const normalizedDbName = dbRoom.name?.toLowerCase().trim()
                const exists = mergedTiles.find(t =>
                    t.id === dbRoom.id ||
                    t.roomId === dbRoom.id ||
                    t.roomName?.toLowerCase().trim() === normalizedDbName
                )
                if (!exists) {
                    mergedTiles.push({
                        id: dbRoom.id,
                        type: 'room',
                        roomId: dbRoom.id,
                        roomName: dbRoom.name,
                        roomIcon: Object.entries(ROOM_ICONS).find(([k]) => dbRoom.name.toLowerCase().includes(k))?.[1] || ROOM_ICONS.default,
                        order: mergedTiles.length,
                        deviceGroups: []
                    })
                    changed = true
                }
            })

            const deduped: DashboardTile[] = []
            const seenNames = new Map<string, number>()
            mergedTiles.forEach(tile => {
                const normName = tile.roomName?.toLowerCase().trim() || tile.id
                if (seenNames.has(normName)) {
                    const existingIdx = seenNames.get(normName)!
                    const existing = deduped[existingIdx]
                    if ((tile.deviceGroups?.length || 0) > (existing.deviceGroups?.length || 0)) {
                        deduped[existingIdx] = tile
                        changed = true
                    }
                } else {
                    seenNames.set(normName, deduped.length)
                    deduped.push(tile)
                }
            })

            if (changed || (!stored && deduped.length > 0)) {
                setTiles(deduped)
            } else if (stored && deduped.length !== mergedTiles.length) {
                setTiles(deduped)
            } else if (stored) {
                setTiles(localTiles)
            }
        } else if (stored) {
            setTiles(localTiles)
        } else {
            setTiles([])
        }

        loadedConnectionIdRef.current = activeConnection.id
    }, [activeConnection?.id, rooms])


    // Save tiles on change (only after the active connection's tiles have loaded)
    useEffect(() => {
        if (activeConnection?.id && loadedConnectionIdRef.current === activeConnection.id) {
            localStorage.setItem(`dashboard_tiles_${activeConnection.id}`, JSON.stringify(tiles))
        }
    }, [tiles, activeConnection?.id])

    // Load Pending Suggestions
    useEffect(() => {
        if (!activeConnection?.id) return
        const loadSuggestions = async () => {
            const { data } = await supabase.from('suggestions')
                .select('*')
                .eq('connection_id', activeConnection.id)
                .eq('status', 'pending')
                .order('created_at', { ascending: false })

            if (data && data.length > 0) {
                setHeaderSuggestions(data as Suggestion[])
            } else {
                setHeaderSuggestions([])
            }
        }
        loadSuggestions()
    }, [activeConnection?.id])

    const handleSuggestionAction = async (id: string, action: 'accept' | 'reject') => {
        const target = headerSuggestions.find(s => s.id === id)
        setHeaderSuggestions(prev => prev.filter(s => s.id !== id))

        if (action === 'accept' && target && activeConnection) {
            try {
                const actions = Array.isArray(target.actions) ? target.actions : []
                let applied = false

                for (const act of actions) {
                    const autoConfig = act.ha_automation || (act.type === 'create_automation' ? (act.data || act.config) : null)
                    if (autoConfig && (autoConfig.alias || autoConfig.trigger || autoConfig.triggers)) {
                        const result = await saveHAAutomation(
                            activeConnection.api_url,
                            activeConnection.api_token,
                            { alias: target.title, mode: 'single', ...autoConfig }
                        )
                        if (!result.success) throw new Error(result.message || 'HA automation save failed')
                        applied = true
                    } else if (act.domain && act.service) {
                        const svcData = act.data || (act.entity_id ? { entity_id: act.entity_id } : {})
                        await callHAService(act.domain, act.service, svcData, activeConnection.api_url, activeConnection.api_token)
                        applied = true
                    }
                }

                if (applied) {
                    setToastMsg(`✅ "${target.title}" uitgevoerd in Home Assistant!`)
                    setTimeout(() => setToastMsg(null), 3000)
                }
            } catch (e: any) {
                logger.error('Failed to apply suggestion', e)
                setToastMsg(`❌ Kon voorstel niet uitvoeren: ${e?.message || 'Fout'}`)
                setTimeout(() => setToastMsg(null), 4000)
                return
            }
        }

        await supabase
            .from('suggestions')
            .update({ status: action === 'accept' ? 'accepted' : 'rejected' })
            .eq('id', id)
            .eq('connection_id', activeConnection?.id || '')
    }

    // --- Actions ---

    const handleToggle = async (entityId: string, currentState: string) => {
        if (!entityId || !activeConnection) {
            logger.warn('Toggle prevented: Missing ID or Connection', { entityId, hasConn: !!activeConnection })
            return
        }

        try {
            console.log(`🖱️ Toggling ${entityId} (Current: ${currentState})`)
            const domain = entityId.split('.')[0]

            let service = 'turn_on'
            let serviceData: any = { entity_id: entityId }

            if (domain === 'light' || domain === 'switch' || domain === 'input_boolean' || domain === 'fan' || domain === 'humidifier') {
                service = 'toggle' // Use toggle to avoid state sync mismatch
            } else if (domain === 'button') {
                service = 'press'
            } else if (domain === 'scene') {
                service = 'turn_on'
            } else if (domain === 'vacuum') {
                service = currentState === 'cleaning' ? 'return_to_base' : 'start'
            } else if (domain === 'automation') {
                service = 'trigger' // Automations are triggered, not toggled
            } else if (domain === 'script') {
                service = 'turn_on'
            } else if (domain === 'media_player') {
                service = 'media_play_pause'
            } else if (domain === 'cover') {
                if (currentState === 'closed') {
                    service = 'open_cover'
                } else {
                    service = 'close_cover'
                }
            } else if (domain === 'lock') {
                service = currentState === 'locked' ? 'unlock' : 'lock'
            }

            await callHAService(domain, service, serviceData, activeConnection.api_url, activeConnection.api_token)
            console.log(`✅ Toggle Sent: ${domain}.${service}`)
            setToastMsg(`Sent: ${service.replace('_', ' ')} to ${entityId}`) // Visual Feedback with ID
            setTimeout(() => setToastMsg(null), 2000)


        } catch (error: any) {
            console.error('Toggle Error:', error)
            setToastMsg(`Error: ${error.message || 'Failed'}`) // Error Feedback
            setTimeout(() => setToastMsg(null), 3000)
            logger.error(`Toggle Failure: ${error.message || error}`, {
                entityId,
                url: error.message?.includes('calling') ? 'See message' : 'Unknown',
                stack: error.stack
            })
        }
    }

    const handleBrightness = async (entityId: string, level: number) => {
        if (!entityId || !activeConnection) return
        try {
            console.log(`🔆 Set Brightness ${entityId} -> ${level}%`)
            await callHAService('light', 'turn_on', {
                entity_id: entityId,
                brightness_pct: level
            }, activeConnection.api_url, activeConnection.api_token)
        } catch (error) {
            logger.error('Brightness adjustment failed', { entityId, error })
        }
    }

    const handleCoverAction = async (entityId: string, action: 'open' | 'close' | 'stop') => {
        if (!entityId || !activeConnection) return
        const service = action === 'open' ? 'open_cover' : action === 'close' ? 'close_cover' : 'stop_cover'
        try {
            console.log(`🪟 Cover Action: ${service} -> ${entityId}`)
            await callHAService('cover', service, { entity_id: entityId }, activeConnection.api_url, activeConnection.api_token)
            setToastMsg(`Sent: ${service} to ${entityId}`)
            setTimeout(() => setToastMsg(null), 2000)
        } catch (error: any) {
            console.error('Cover Error:', error)
            setToastMsg(`Error: ${error.message}`)
        }
    }

    // --- Layout Management ---

    const handleAddRoom = () => {
        if (!newRoomName.trim()) return
        const newTile: DashboardTile = {
            id: `room-${Date.now()}`,
            type: 'room',
            roomName: newRoomName,
            roomIcon: Object.entries(ROOM_ICONS).find(([k]) => newRoomName.toLowerCase().includes(k))?.[1] || ROOM_ICONS.default,
            order: tiles.length,
            deviceGroups: []
        }
        setTiles([...tiles, newTile])
        setShowAddRoomModal(false)
        setNewRoomName('')
    }

    const handleDeleteRoom = (tileId: string) => {
        if (window.confirm('Delete this room and all its devices?')) {
            setTiles(tiles.filter(t => t.id !== tileId))
        }
    }

    // --- Device Management ---

    const handleAddDevice = (typeDef: typeof DEVICE_TYPES[0]) => {
        const newDevice: RoomDevice = {
            id: `dev-${Date.now()}`,
            type: typeDef.id,
            name: typeDef.name,
            icon: typeDef.icon,
            entityId: ''
        }
        setEditingDevice(newDevice)
        setSelectedEntityId('') // Reset selection
        setShowDevicePicker(false) // Close picker, open editor
    }

    const saveDevice = () => {
        if (!configTileId || !editingDevice) return

        const updatedTiles = tiles.map(tile => {
            if (tile.id === configTileId) {
                // Find if this device exists in ANY group
                // For simplified Manual Editing: We assume 1 Group = 1 Device for manual items?
                // Or we create a "Manual Devices" group if none exists?

                // Let's create a dedicated "Manual" group if it doesn't exist
                let groups = [...tile.deviceGroups]
                let manualGroup = groups.find(g => g.id === 'manual-group')

                if (!manualGroup) {
                    manualGroup = {
                        id: 'manual-group',
                        name: 'Manually Added',
                        entities: []
                    }
                    groups.push(manualGroup)
                }

                // Check if device exists in ANY group (could be editing an HA imported one too)
                let found = false
                const newGroups = groups.map(g => {
                    const existingIndex = g.entities.findIndex(d => d.id === editingDevice.id)
                    if (existingIndex >= 0) {
                        found = true
                        const updatedEntities = [...g.entities]
                        updatedEntities[existingIndex] = { ...editingDevice, entityId: selectedEntityId }
                        return { ...g, entities: updatedEntities }
                    }
                    return g
                })

                if (found) {
                    // Updated existing
                    return { ...tile, deviceGroups: newGroups }
                } else {
                    // Add to Manual Group
                    const finalDevice = { ...editingDevice, entityId: selectedEntityId }
                    // Update reference to manual group in the newGroups array
                    // We need to re-find manual group in newGroups because we just mapped over it
                    const targetGroupIndex = newGroups.findIndex(g => g.id === 'manual-group')
                    if (targetGroupIndex >= 0) {
                        const updatedEntities = [...newGroups[targetGroupIndex].entities, finalDevice]
                        newGroups[targetGroupIndex] = { ...newGroups[targetGroupIndex], entities: updatedEntities }
                    }
                    return { ...tile, deviceGroups: newGroups }
                }
            }
            return tile
        })
        setTiles(updatedTiles)
        setEditingDevice(null)
        // Keep config modal open
    }

    const removeDevice = (tileId: string, groupId: string, deviceId: string) => {
        const updatedTiles = tiles.map(tile => {
            if (tile.id === tileId) {
                const newGroups = tile.deviceGroups.map(g => {
                    if (g.id === groupId) {
                        return { ...g, entities: g.entities.filter(d => d.id !== deviceId) }
                    }
                    return g
                }).filter(g => g.entities.length > 0) // Remove empty groups
                return { ...tile, deviceGroups: newGroups }
            }
            return tile
        })
        setTiles(updatedTiles)
    }




    // Independent Sync Function
    const performToolSync = (connection: any, currentEntityStates: Record<string, any>) => {
        if (!connection) return

        import('../utils/mcp-sync').then(async ({ fetchHAServices, syncBatchToLibrarian }) => {
            try {
                // Ensure we have entities to map against
                const entities = Object.values(currentEntityStates || {}).map((s: any) => ({
                    entity_id: s.entity_id || '',
                    state: s.state,
                    attributes: s.attributes
                })).filter(e => e.entity_id);

                console.log('[Dashboard] Starting Full Sync...');
                setToastMsg('🔄 Starting Sync Process...');

                // 1. Fetch RAW services from HA
                console.log('[Dashboard] Fetching services from HA API...');
                const allServices = await fetchHAServices(connection.api_url, connection.api_token);
                console.log('[Dashboard] Services fetched successfully.');

                // 2. Queue ALL services
                const syncQueue: Array<{ domain: string; name: string; service: any }> = [];
                Object.entries(allServices).forEach(([domain, services]) => {
                    Object.entries(services as any).forEach(([svcName, svcData]) => {
                        syncQueue.push({ domain, name: svcName, service: svcData });
                    });
                });

                const totalCount = syncQueue.length;
                console.log(`[Dashboard] Found ${totalCount} services. (Filtering disabled)`);
                setToastMsg(`Found ${totalCount} tools. Starting AI indexing...`);

                // 3. Batch Process with accumulation
                const BATCH_SIZE = 10;
                let processedCount = 0;
                const totalBatches = Math.ceil(totalCount / BATCH_SIZE);

                for (let i = 0; i < totalCount; i += BATCH_SIZE) {
                    const batchIndex = Math.floor(i / BATCH_SIZE);
                    const isFirstBatch = batchIndex === 0;
                    const isLastBatch = batchIndex === totalBatches - 1;

                    // Determine sync_mode for accumulation
                    let sync_mode: 'start' | 'append' | 'complete' | 'replace' = 'append';
                    if (totalBatches === 1) sync_mode = 'replace';
                    else if (isFirstBatch) sync_mode = 'start';
                    else if (isLastBatch) sync_mode = 'complete';

                    const batch = syncQueue.slice(i, i + BATCH_SIZE);
                    console.log(`[Dashboard] Processing batch ${batchIndex + 1}/${totalBatches} (mode: ${sync_mode})...`);

                    const batchServices: Record<string, any> = {};
                    batch.forEach(item => {
                        if (!batchServices[item.domain]) batchServices[item.domain] = {};
                        batchServices[item.domain][item.name] = item.service;
                    });

                    const progressPct = Math.round((processedCount / totalCount) * 100);
                    setToastMsg(`🧠 Indexing tools: ${progressPct}% (${processedCount}/${totalCount})`);

                    try {
                        const result = await syncBatchToLibrarian(
                            connection.id,
                            entities,
                            batchServices,
                            sync_mode
                        );
                        if (result.success) {
                            console.log(`[Dashboard] Batch done. Total: ${result.devices} devices, ${result.tools} tools`);
                        } else {
                            console.error('[Dashboard] Batch error:', result.error);
                        }
                    } catch (batchErr) {
                        console.error('[Dashboard] Batch failed:', batchErr);
                    }

                    processedCount += batch.length;
                    await new Promise(r => setTimeout(r, 500));
                }

                console.log('[Dashboard] Sync Complete!');
                setToastMsg(`✅ Sync Complete! ${totalCount} tools ready.`);

            } catch (err: any) {
                console.error('[Dashboard] Sync Failed:', err);
                setToastMsg(`❌ Sync Error: ${err.message}`);
            }
        }).catch((importErr: any) => {
            console.error('[Dashboard] Failed to import sync module:', importErr);
            setToastMsg('❌ Sync Module Load Failed');
        });
    }

    // Build Dashboard tiles from HA Registries (preferred) OR REST topology / live entityStates fallback
    const buildTilesFromHA = (
        areasList: any[],
        devicesList: any[],
        entitiesRegList: any[],
        statesMap: Record<string, any>
    ): { newTiles: DashboardTile[]; areasCreatedCount: number; devicesAddedCount: number } => {
        const newTiles: DashboardTile[] = []
        let devicesAddedCount = 0
        let areasCreatedCount = 0

        const getOrCreateTile = (areaId: string, areaName: string, iconOverride?: string): DashboardTile => {
            let tile = newTiles.find(t => t.roomId === areaId)
            if (!tile) {
                const lowerName = areaName.toLowerCase()
                const icon = iconOverride || Object.entries(ROOM_ICONS).find(([k]) => lowerName.includes(k))?.[1] || ROOM_ICONS.default

                tile = {
                    id: areaId,
                    type: 'room',
                    roomId: areaId,
                    roomName: areaName,
                    roomIcon: icon,
                    order: newTiles.length,
                    deviceGroups: []
                }
                newTiles.push(tile)
                areasCreatedCount++
            }
            return tile
        }

        const unassignedTile: DashboardTile = {
            id: 'unassigned',
            type: 'room',
            roomId: 'unassigned',
            roomName: 'Overige Apparaten',
            roomIcon: '📦',
            order: 999,
            deviceGroups: []
        }

        const isDiagEntity = (entityId: string, entityCategory?: string) => {
            if (entityCategory === 'diagnostic' || entityCategory === 'config') return true
            const lower = entityId.toLowerCase()
            return (
                lower.includes('_battery') ||
                lower.includes('_firmware') ||
                lower.includes('_update') ||
                lower.includes('_signal_strength') ||
                lower.includes('_rssi') ||
                lower.includes('_linkquality') ||
                lower.includes('_uptime') ||
                lower.includes('_identify')
            )
        }

        const scorePrimaryEntity = (e: RoomDevice) => {
            const eid = (e.entityId || '').toLowerCase()
            if (e.isDiagnostic) return -10
            if (eid.startsWith('light.')) return 20
            if (eid.startsWith('climate.')) return 19
            if (eid.startsWith('cover.')) return 18
            if (eid.startsWith('switch.')) return 17
            if (eid.startsWith('lock.')) return 16
            if (eid.startsWith('fan.') || eid.startsWith('vacuum.') || eid.startsWith('water_heater.')) return 15
            if (eid.startsWith('media_player.')) return 14
            // Appliance status/program/remaining sensors (e.g. washing machine, dryer, dishwasher)
            if (eid.startsWith('sensor.')) {
                if (/operation_state|machine_state|status|state|phase|program|programma|remaining|resterend|progress|cycle/.test(eid)) return 12
                if (/power|watt|energy|temp/.test(eid)) return 6
                return 4
            }
            if (eid.startsWith('binary_sensor.')) {
                if (/door|deur|window|raam|running|active|motion|occupancy/.test(eid)) return 8
                return 3
            }
            if (eid.startsWith('select.') || eid.startsWith('button.') || eid.startsWith('number.')) return 7
            return 1
        }

        // Pre-populate tiles with all HA areas
        if (Array.isArray(areasList) && areasList.length > 0) {
            areasList.forEach(area => {
                if (area?.area_id) getOrCreateTile(area.area_id, area.name || area.area_id)
            })
        }

        const coveredEntityIds = new Set<string>()
        const deviceMap = new Map<string, DeviceGroup>()

        // PATH A: Rich HA WebSocket Registries available
        if (Array.isArray(entitiesRegList) && entitiesRegList.length > 0) {
            // NOTE: disabled_by may be null OR undefined — use !e.disabled_by!
            const activeRegistryEntities = entitiesRegList.filter(e => e?.entity_id && !e.hidden_by && !e.disabled_by)
            const orphans: any[] = []

            activeRegistryEntities.forEach(regEntity => {
                coveredEntityIds.add(regEntity.entity_id)
                const liveState = statesMap[regEntity.entity_id]
                const domain = regEntity.entity_id.split('.')[0]
                const typeDef = DEVICE_TYPES.find(dt => dt.domain === domain) || { id: 'sensor', icon: '👁️', name: 'Sensor' }
                const friendlyName = regEntity.name || regEntity.original_name || liveState?.attributes?.friendly_name || regEntity.entity_id

                if (regEntity.device_id) {
                    if (!deviceMap.has(regEntity.device_id)) {
                        const haDevice = (devicesList || []).find(d => d.id === regEntity.device_id)
                        deviceMap.set(regEntity.device_id, {
                            id: regEntity.device_id,
                            name: haDevice?.name_by_user || haDevice?.name || friendlyName,
                            manufacturer: haDevice?.manufacturer,
                            model: haDevice?.model,
                            areaId: haDevice?.area_id || regEntity.area_id,
                            entities: []
                        })
                    }
                    const group = deviceMap.get(regEntity.device_id)!
                    group.entities.push({
                        id: `ent-${regEntity.entity_id}`,
                        type: typeDef.id,
                        name: friendlyName,
                        icon: getApplianceIcon(`${group.name} ${friendlyName}`, typeDef.icon),
                        entityId: regEntity.entity_id,
                        deviceId: regEntity.device_id,
                        isDiagnostic: isDiagEntity(regEntity.entity_id, regEntity.entity_category)
                    })

                    if (!group.areaId && regEntity.area_id) {
                        group.areaId = regEntity.area_id
                    }
                } else {
                    orphans.push(regEntity)
                }
            })

            deviceMap.forEach(group => {
                group.entities.sort((a, b) => scorePrimaryEntity(b) - scorePrimaryEntity(a))
                group.primaryEntity = group.entities[0]

                let tile: DashboardTile
                if (group.areaId) {
                    const area = (areasList || []).find(a => a.area_id === group.areaId)
                    tile = getOrCreateTile(group.areaId, area?.name || group.areaId)
                } else {
                    tile = unassignedTile
                }
                tile.deviceGroups.push(group)
                devicesAddedCount++
            })

            orphans.forEach(orp => {
                const domain = orp.entity_id.split('.')[0]
                if (domain === 'sun' || domain === 'weather' || domain === 'zone' || domain === 'person' || domain === 'update') return
                const liveState = statesMap[orp.entity_id]
                const typeDef = DEVICE_TYPES.find(dt => dt.domain === domain) || { id: 'sensor', icon: '👁️', name: 'Sensor' }
                const friendlyName = orp.name || orp.original_name || liveState?.attributes?.friendly_name || orp.entity_id

                const virtualGroup: DeviceGroup = {
                    id: `orp-${orp.entity_id}`,
                    name: friendlyName,
                    entities: [{
                        id: `ent-${orp.entity_id}`,
                        type: typeDef.id,
                        name: friendlyName,
                        icon: getApplianceIcon(friendlyName, typeDef.icon),
                        entityId: orp.entity_id,
                        isDiagnostic: isDiagEntity(orp.entity_id, orp.entity_category)
                    }]
                }
                virtualGroup.primaryEntity = virtualGroup.entities[0]

                let tile: DashboardTile
                if (orp.area_id) {
                    const area = (areasList || []).find(a => a.area_id === orp.area_id)
                    tile = getOrCreateTile(orp.area_id, area?.name || orp.area_id)
                } else {
                    tile = unassignedTile
                }
                tile.deviceGroups.push(virtualGroup)
                devicesAddedCount++
            })
        }

        // PATH B: Also include any live entityStates not covered by registry (e.g. REST-only mode or custom template entities!)
        const liveEntries = Object.values(statesMap || {}).filter((s: any) => s?.entity_id && !coveredEntityIds.has(s.entity_id))
        if (liveEntries.length > 0) {
            // Try matching area via cached ha_topology if available
            const entityToArea = new Map<string, { id: string; name: string }>()
            try {
                const topoRaw = (activeConnection?.id && localStorage.getItem(`ha_topology_${activeConnection.id}`))
                    || localStorage.getItem('ha_topology_latest')
                if (topoRaw) {
                    const topo = JSON.parse(topoRaw)
                    ;(topo.areas || []).forEach((a: any) => {
                        ;(a.entities || []).forEach((eid: string) => {
                            entityToArea.set(eid, { id: a.id, name: a.name })
                        })
                    })
                }
            } catch { }

            const skipDomains = new Set(['sun', 'weather', 'zone', 'person', 'update', 'tts', 'stt', 'conversation', 'persistent_notification', 'device_tracker'])
            liveEntries.forEach((s: any) => {
                const domain = s.entity_id.split('.')[0]
                if (skipDomains.has(domain)) return
                const typeDef = DEVICE_TYPES.find(dt => dt.domain === domain) || { id: 'sensor', icon: '👁️', name: 'Sensor' }
                const friendlyName = s.attributes?.friendly_name || s.entity_id
                const devGroup: DeviceGroup = {
                    id: `live-${s.entity_id}`,
                    name: friendlyName,
                    entities: [{
                        id: `ent-${s.entity_id}`,
                        type: typeDef.id,
                        name: friendlyName,
                        icon: getApplianceIcon(friendlyName, typeDef.icon),
                        entityId: s.entity_id,
                        isDiagnostic: isDiagEntity(s.entity_id)
                    }]
                }
                devGroup.primaryEntity = devGroup.entities[0]

                const areaMatch = entityToArea.get(s.entity_id)
                const tile = areaMatch ? getOrCreateTile(areaMatch.id, areaMatch.name) : unassignedTile
                tile.deviceGroups.push(devGroup)
                devicesAddedCount++
            })
        }

        if (unassignedTile.deviceGroups.length > 0) {
            newTiles.push(unassignedTile)
        }

        newTiles.sort((a, b) => {
            if (a.id === 'unassigned') return 1
            if (b.id === 'unassigned') return -1
            return (a.roomName || '').localeCompare(b.roomName || '')
        })

        newTiles.forEach(tile => {
            tile.deviceGroups.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        })

        return { newTiles, areasCreatedCount, devicesAddedCount }
    }

    // Automatic first-load layout population:
    // Whenever tiles are empty (or all rooms have 0 devices) and HA data arrives, populate automatically!
    useEffect(() => {
        if (!activeConnection?.id) return
        if (loadedConnectionIdRef.current !== activeConnection.id) return

        const totalDevicesInTiles = tiles.reduce((sum, t) => sum + (t.deviceGroups?.length || 0), 0)
        const hasRegistryData = (haEntitiesRegistry?.length || 0) > 0
        const hasStateData = Object.keys(entityStates || {}).length > 0

        if (!hasRegistryData && !hasStateData) return

        // Auto-populate if dashboard currently has 0 devices, OR upgrade REST-only auto-import once full HA registry arrives
        const importKey = `${activeConnection.id}:${hasRegistryData ? 'reg' : 'states'}`
        if (totalDevicesInTiles === 0 || (hasRegistryData && autoImportedConnRef.current === `${activeConnection.id}:states`)) {
            if (autoImportedConnRef.current === importKey) return
            const { newTiles, devicesAddedCount } = buildTilesFromHA(haAreas, haDevices, haEntitiesRegistry, entityStates)
            if (devicesAddedCount > 0) {
                autoImportedConnRef.current = importKey
                setTiles(newTiles)
                logger.info(`✅ [Dashboard] Auto-populated ${newTiles.length} rooms & ${devicesAddedCount} devices from Home Assistant`)
            }
        }
    }, [activeConnection?.id, haAreas, haDevices, haEntitiesRegistry, entityStates, tiles.length])

    // Manual HA Registry Import (with REST fallback if WS registries are still empty!)
    const importLayoutFromHA = async () => {
        if (tiles.length > 0 && !window.confirm("Dit vernieuwt je dashboard met de actuele ruimtes en apparaten uit Home Assistant. Doorgaan?")) {
            return
        }

        setIsSyncingLayout(true)
        try {
            let statesToUse = entityStates
            // If WebSocket registries aren't available yet, also fetch topology & states via REST
            if ((!haEntitiesRegistry || haEntitiesRegistry.length === 0) && activeConnection?.api_url && activeConnection?.api_token) {
                try {
                    const { fetchSmartHASync } = await import('../utils/ha-api')
                    await fetchSmartHASync(activeConnection.api_url, activeConnection.api_token, activeConnection.id)
                } catch { }
            }

            if (Object.keys(statesToUse || {}).length === 0 && activeConnection?.api_url && activeConnection?.api_token) {
                try {
                    const { buildHAUrl, sanitizeHAToken, fetchWithTimeout } = await import('../utils/home-assistant')
                    const res = await fetchWithTimeout(buildHAUrl('/api/states', activeConnection.api_url), {
                        headers: { Authorization: `Bearer ${sanitizeHAToken(activeConnection.api_token)}` }
                    }, 15000)
                    if (res.ok) {
                        const arr = await res.json()
                        if (Array.isArray(arr)) {
                            const map: Record<string, any> = {}
                            arr.forEach((s: any) => { if (s?.entity_id) map[s.entity_id] = s })
                            statesToUse = map
                        }
                    }
                } catch { }
            }

            const { newTiles, areasCreatedCount, devicesAddedCount } = buildTilesFromHA(
                haAreas || [],
                haDevices || [],
                haEntitiesRegistry || [],
                statesToUse || {}
            )

            if (newTiles.length > 0 || devicesAddedCount > 0) {
                autoImportedConnRef.current = `${activeConnection?.id || ''}:${(haEntitiesRegistry?.length || 0) > 0 ? 'reg' : 'states'}`
                setTiles(newTiles)

                if (activeConnection) {
                    performToolSync(activeConnection, statesToUse)
                }

                setToastMsg(`✅ ${devicesAddedCount} apparaten in ${areasCreatedCount} ruimtes gesynchroniseerd!`)
                setTimeout(() => setToastMsg(null), 4000)
            } else {
                alert("Geen apparaten of ruimtes gevonden in je Home Assistant configuratie. Controleer je URL en token.")
            }
        } finally {
            setIsSyncingLayout(false)
        }
    }



    const openRoomConfig = (tileId: string) => {
        setConfigTileId(tileId)
        setEditingDevice(null)
        setShowDevicePicker(false)
    }

    // --- Render Helpers ---

    const renderSlider = (entityId: string, currentBri: number) => {
        // Simple click-to-set slider simulation
        return (
            <div className="slider-container"
                onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const pct = Math.min(100, Math.max(0, Math.round((x / rect.width) * 100)));
                    handleBrightness(entityId, pct);
                }}
            >
                <div className="slider-fill" style={{ width: `${currentBri}%` }}></div>
                <span className="slider-value">{currentBri}%</span>
            </div>
        )
    }

    // --- UI Helpers ---

    const getDevicePriority = (type: string) => {
        // High priority: Controls that do things
        if (['light', 'switch', 'lock', 'cover', 'climate', 'media', 'input_boolean', 'automation'].includes(type)) return 0
        // Medium: Binary Sensors (often security/occupancy)
        if (type === 'binary_sensor') return 1
        // Low: Read-only sensors
        return 2
    }



    // New: Render merged layout (Device List)
    const renderRoomCard = (tile: DashboardTile) => {
        // 1. Flatten for "Header Sensors" check (Temp/Hum)
        // We look for any entity in any group that matches

        let temp: { config: RoomDevice, ha: any } | undefined;
        let hum: { config: RoomDevice, ha: any } | undefined;

        if (tile.id !== 'unassigned') {
            const allEntities = tile.deviceGroups.flatMap(g => g.entities).map(d => ({ config: d, ha: entityStates[d.entityId || ''] }))

            // Helper: Avoid batteries and non-relevant sensors
            const isValidEnv = (d: any) => {
                const id = d.config.entityId?.toLowerCase() || '';
                // Exclude battery, power, signal, and hardware/system temps (cpu, wifi, etc)
                if (id.includes('battery') || id.includes('power') || id.includes('signal') ||
                    id.includes('cpu') || id.includes('processor') || id.includes('wifi') ||
                    id.includes('uptime') || id.includes('device_temp')) return false;

                const state = parseFloat(d.ha?.state);
                return !isNaN(state);
            }

            temp = allEntities.find(d =>
                (d.config.type === 'climate' || d.ha?.attributes?.device_class === 'temperature') &&
                isValidEnv(d)
            );

            hum = allEntities.find(d =>
                d.ha?.attributes?.device_class === 'humidity' &&
                isValidEnv(d)
            );
        }

        const tempVal = temp?.ha?.state
        const tempUnit = temp?.ha?.attributes?.unit_of_measurement || ''
        const humVal = hum?.ha?.state
        const humUnit = hum?.ha?.attributes?.unit_of_measurement || ''

        return (
            <div key={tile.id} className="room-card" onClick={() => setDetailTileId(tile.id)}>
                {editMode && (
                    <button className="tile-delete-btn" onClick={(e) => { e.stopPropagation(); handleDeleteRoom(tile.id) }}>✕</button>
                )}

                <div className="room-header">
                    <div className="room-title">
                        <span style={{ fontSize: '1.5rem' }}>
                            {/* Dynamic Weather Icon */}
                            {(tile.id.includes('weather') && entityStates['sun.sun']) ?
                                (entityStates['sun.sun'].state === 'below_horizon' ? '🌙' : '☀️')
                                : tile.roomIcon
                            }
                        </span>
                        <span style={{ fontSize: '1.2rem', fontWeight: 600 }}>{tile.roomName}</span>

                        {/* Environmental Info */}
                        {(tempVal || humVal) && (
                            <span style={{ marginLeft: 12, fontSize: '0.9rem', opacity: 0.7, fontWeight: 400 }}>
                                {tempVal && <span>{tempVal}{tempUnit}</span>}
                                {tempVal && humVal && <span style={{ margin: '0 6px' }}>•</span>}
                                {humVal && <span>{humVal}{humUnit}</span>}
                            </span>
                        )}
                    </div>
                </div>

                {tile.id === 'unassigned' ? (
                    <div style={{ padding: '16px 0', textAlign: 'center', opacity: 0.75 }}>
                        <div style={{ fontSize: '2rem', marginBottom: 6 }}>📦</div>
                        <div style={{ fontWeight: 600 }}>{tile.deviceGroups.length} Overige Apparaten</div>
                        <div style={{ fontSize: '0.8rem', opacity: 0.75 }}>(Tik om alle apparaten te bekijken)</div>
                    </div>
                ) : (
                    <div className="room-entity-list" style={{ marginTop: 8 }}>
                        {tile.deviceGroups.length === 0 && (
                            <div style={{ opacity: 0.5, fontSize: '0.8rem', padding: '10px 0' }}>Geen apparaten in deze kamer.</div>
                        )}
                        {[...tile.deviceGroups]
                            .filter(g => {
                                const primary = g.primaryEntity || g.entities[0];
                                if (!primary) return false;
                                // Only hide pure diagnostic-only items from the summary card (still visible in detail view!)
                                if (primary.isDiagnostic && g.entities.every(e => e.isDiagnostic)) return false;
                                return true;
                            })
                            .sort((a, b) => {
                                const typeA = a.primaryEntity?.type || 'sensor'
                                const typeB = b.primaryEntity?.type || 'sensor'
                                const priA = getDevicePriority(typeA)
                                const priB = getDevicePriority(typeB)
                                if (priA !== priB) return priA - priB
                                return a.name.localeCompare(b.name)
                            })
                            .map(group => {
                                const primary = group.primaryEntity || group.entities[0]
                                if (!primary) return null

                                const ha = entityStates[primary.entityId || '']
                                const config = primary

                                const isToggleable = ['light', 'switch', 'input_boolean', 'lock', 'media', 'cover', 'fan', 'vacuum', 'humidifier'].includes(config.type)
                                const isActive = ha?.state === 'on' || ha?.state === 'playing' || ha?.state === 'open' || ha?.state === 'running' || ha?.state === 'cleaning'
                                const isWarm = (config.type === 'sensor' || config.type === 'climate') && (ha?.attributes?.device_class === 'temperature')

                                let stateDisplay = ha?.state || 'Onbekend'

                                if (config.entityId === 'sun.sun') {
                                    stateDisplay = ha?.state === 'above_horizon' ? 'Dag' : 'Nacht'
                                } else if ((config.type === 'binary_sensor' || config.entityId?.includes('door') || config.entityId?.includes('window')) && (
                                    config.entityId?.includes('door') ||
                                    config.entityId?.includes('window') ||
                                    config.entityId?.includes('opening') ||
                                    ha?.attributes?.device_class === 'door' ||
                                    ha?.attributes?.device_class === 'window' ||
                                    ha?.attributes?.device_class === 'garage_door'
                                )) {
                                    stateDisplay = ha?.state === 'on' ? 'Open' : 'Dicht'
                                } else if (config.type === 'light') {
                                    stateDisplay = isActive ? 'Aan' : 'Uit'
                                } else if (config.type === 'cover') {
                                    if (ha?.state === 'open' && ha.attributes?.current_position !== undefined) {
                                        stateDisplay = `Open (${ha.attributes.current_position}%)`
                                    } else {
                                        stateDisplay = ha?.state === 'open' ? 'Open' : ha?.state === 'closed' ? 'Dicht' : ha?.state || 'Onbekend'
                                    }
                                }

                                if (ha?.attributes?.unit_of_measurement) stateDisplay += ` ${ha.attributes.unit_of_measurement}`
                                if (!ha?.attributes?.unit_of_measurement && stateDisplay.includes('_')) {
                                    stateDisplay = stateDisplay.replace(/_/g, ' ')
                                }
                                if (!ha?.attributes?.unit_of_measurement && stateDisplay.length < 24 && !stateDisplay.includes('(')) {
                                    stateDisplay = stateDisplay.charAt(0).toUpperCase() + stateDisplay.slice(1)
                                }
                                if (config.id.includes('motion')) stateDisplay = isActive ? 'Beweging' : 'Rustig'

                                // For multi-entity HA devices (like Wasmachine / Droogkast), show the Device Name clearly!
                                const displayName = (group.entities.length > 1 && group.name && group.name !== 'Unknown Device')
                                    ? group.name
                                    : (config.name || group.name)

                                return (
                                    <div key={group.id} className="entity-row">
                                        <div className="entity-main">
                                            <div className={`entity-icon ${isActive ? 'active' : ''} ${isWarm ? 'warm' : ''}`}>
                                                {config.icon}
                                            </div>
                                            <div className="entity-name">{displayName}</div>
                                        </div>

                                        {isToggleable ? (
                                            <div className={`toggle-switch compact ${isActive ? 'on' : ''}`}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleToggle(config.entityId!, ha?.state || 'off')
                                                }}>
                                            </div>
                                        ) : (
                                            <div className="entity-state">{stateDisplay}</div>
                                        )}
                                    </div>
                                )
                            })}
                    </div>
                )}
            </div>
        )
    }

    const handleClimateTemp = async (entityId: string, newTemp: number) => {
        if (!entityId || !activeConnection) return
        try {
            await callHAService('climate', 'set_temperature', { entity_id: entityId, temperature: newTemp }, activeConnection.api_url, activeConnection.api_token)
            setToastMsg(`🌡️ ${entityId} → ${newTemp}°C`)
            setTimeout(() => setToastMsg(null), 2000)
        } catch (err: any) {
            setToastMsg(`Error: ${err.message}`)
            setTimeout(() => setToastMsg(null), 3000)
        }
    }

    // UPDATED: Inline Detail View (Not Modal)
    const renderDetailView = () => {
        const tile = tiles.find(t => t.id === detailTileId)
        if (!tile) return null

        // 1. Flatten all entities from groups
        const allEntities = tile.deviceGroups.flatMap(g => g.entities)

        // 2. Categorize
        const primaryDevices = allEntities.filter(d => !d.isDiagnostic)
        const diagnosticDevices = allEntities.filter(d => d.isDiagnostic)

        const covers = primaryDevices.filter(e => e.type === 'cover')
        const climateDevices = primaryDevices.filter(e => e.type === 'climate' || e.type === 'water_heater')
        const controlTypes = new Set(['light', 'switch', 'input_boolean', 'lock', 'media', 'fan', 'vacuum', 'humidifier', 'button', 'scene', 'script'])
        const controls = primaryDevices.filter(e => controlTypes.has(e.type))
        const sensors = primaryDevices.filter(e => !controlTypes.has(e.type) && e.type !== 'cover' && e.type !== 'climate' && e.type !== 'water_heater')

        const renderCard = (config: RoomDevice) => {
            const ha = entityStates[config.entityId || '']
            if (!ha) return null

            const isOn = ha.state === 'on' || ha.state === 'playing' || ha.state === 'open' || ha.state === 'unlocked' || ha.state === 'cleaning'
            const isLight = config.type === 'light'
            const isCover = config.type === 'cover'
            const isClimate = config.type === 'climate'
            const isLock = config.type === 'lock'
            const isMedia = config.type === 'media'
            const isTriggerable = config.type === 'button' || config.type === 'scene' || config.type === 'script'
            const isToggleControl = isLight || config.type === 'switch' || config.type === 'input_boolean' || isLock || isMedia || config.type === 'fan' || config.type === 'vacuum' || config.type === 'humidifier'
            const isSensor = !isCover && !isClimate && !isToggleControl && !isTriggerable
            const brightness = ha.attributes?.brightness ? Math.round((ha.attributes.brightness / 255) * 100) : 0

            // Only match diagnostics when deviceId is actually defined
            const myDiagnostics = config.deviceId
                ? diagnosticDevices.filter(d => d.deviceId === config.deviceId)
                : []

            // Value Display
            let valueDisplay = ha.state
            if (isCover) {
                valueDisplay = ha.state === 'open' ? 'Open' : ha.state === 'closed' ? 'Dicht' : ha.state
            } else if (isClimate) {
                const cur = ha.attributes?.current_temperature
                const target = ha.attributes?.temperature
                valueDisplay = `${ha.state}${cur !== undefined ? ` • ${cur}°` : ''}${target !== undefined ? ` → ${target}°` : ''}`
            } else if (isLight) {
                valueDisplay = isOn ? (brightness > 0 ? `Aan • ${brightness}%` : 'Aan') : 'Uit'
            } else if (isLock) {
                valueDisplay = ha.state === 'locked' ? 'Vergrendeld' : ha.state === 'unlocked' ? 'Ontgrendeld' : ha.state
            } else if (isMedia) {
                valueDisplay = ha.attributes?.media_title ? `${ha.state} • ${ha.attributes.media_title}` : ha.state
            } else if (isTriggerable) {
                valueDisplay = config.type === 'button' ? 'Druk om uit te voeren' : 'Activeer'
            } else if (!isSensor) {
                valueDisplay = isOn ? 'Aan' : 'Uit'
            } else if (ha.attributes?.unit_of_measurement) {
                valueDisplay += ` ${ha.attributes.unit_of_measurement}`
            }

            const iconColor = isOn || (isCover && ha.state === 'open') || (isClimate && ha.state !== 'off') ? 'var(--accent)' : 'var(--text-secondary)'
            const targetTemp = typeof ha.attributes?.temperature === 'number' ? ha.attributes.temperature : 20

            return (
                <div key={config.id} className="detail-card" style={{ position: 'relative' }}>
                    <div className="detail-card-header">
                        <div className="detail-icon" style={{ color: iconColor }}>
                            {config.icon}
                        </div>
                        <div className="detail-info">
                            <div className="detail-name">{config.name}</div>
                            <div className="detail-state">{valueDisplay}</div>
                        </div>

                        {/* Toggle for controllable switches, lights, locks, fans, vacuums, media players */}
                        {isToggleControl && (
                            <div className={`toggle-switch compact ${isOn ? 'on' : ''} detail-toggle`}
                                onClick={(e) => { e.stopPropagation(); handleToggle(config.entityId!, ha.state || 'off') }}>
                            </div>
                        )}

                        {/* Action button for button/scene/script entities */}
                        {isTriggerable && (
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); handleToggle(config.entityId!, ha.state || 'off') }}
                                style={{
                                    padding: '4px 10px',
                                    borderRadius: '8px',
                                    background: 'rgba(99, 102, 241, 0.2)',
                                    border: '1px solid rgba(99, 102, 241, 0.4)',
                                    color: '#a5b4fc',
                                    fontSize: '0.75rem',
                                    fontWeight: 600,
                                    cursor: 'pointer'
                                }}
                            >
                                ▶
                            </button>
                        )}
                    </div>

                    {/* Climate Controls */}
                    {isClimate && (
                        <div className="detail-controls-row" style={{ paddingLeft: myDiagnostics.length > 0 ? 32 : 0 }}>
                            <div className="control-btn-icon" onClick={(e) => { e.stopPropagation(); handleClimateTemp(config.entityId!, Math.round((targetTemp - 0.5) * 2) / 2) }}>
                                −
                            </div>
                            <div style={{ fontSize: '0.85rem', fontWeight: 600, minWidth: 44, textAlign: 'center' }}>{targetTemp}°</div>
                            <div className="control-btn-icon" onClick={(e) => { e.stopPropagation(); handleClimateTemp(config.entityId!, Math.round((targetTemp + 0.5) * 2) / 2) }}>
                                +
                            </div>
                        </div>
                    )}

                    {/* Cover Controls Row */}
                    {isCover && (
                        <div className="detail-controls-row" style={{ paddingLeft: myDiagnostics.length > 0 ? 32 : 0 }}>
                            <div className="control-btn-icon" onClick={(e) => { e.stopPropagation(); handleCoverAction(config.entityId!, 'open') }}>
                                ⬆
                            </div>
                            <div className="control-btn-icon" onClick={(e) => { e.stopPropagation(); handleCoverAction(config.entityId!, 'stop') }}>
                                ⏹
                            </div>
                            <div className="control-btn-icon" onClick={(e) => { e.stopPropagation(); handleCoverAction(config.entityId!, 'close') }}>
                                ⬇
                            </div>
                        </div>
                    )}

                    {/* Light Brightness Slider (if on) */}
                    {isLight && isOn && (
                        <div style={{ marginTop: 'auto', padding: '8px 0', paddingLeft: myDiagnostics.length > 0 ? 32 : 0 }}>
                            {renderSlider(config.entityId!, brightness)}
                        </div>
                    )}

                    {/* Diagnostics Button - Bottom Left */}
                    {myDiagnostics.length > 0 && (
                        <div style={{
                            position: 'absolute',
                            bottom: 2,
                            left: 8,
                            width: 24,
                            height: 24,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            opacity: 0.5,
                            fontSize: '0.9rem'
                        }}
                            onClick={(e) => {
                                e.stopPropagation();
                                setInspectorData({ name: config.name, diagnostics: myDiagnostics })
                            }}>
                            ℹ️
                        </div>
                    )}
                </div>
            )
        }

        return (
            <div className="detail-view" style={{
                background: 'var(--bg-card)',
                borderRadius: '24px',
                border: '1px solid var(--border)',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                flex: 1,
                width: '100%'
            }}>
                {/* Header */}
                <div className="detail-header" style={{ display: 'flex', alignItems: 'center', marginBottom: '24px', gap: '16px' }}>
                    <button onClick={() => setDetailTileId(null)} style={{ background: 'transparent', fontSize: '1.2rem', padding: 8, color: 'var(--text-primary)' }}>⬅</button>
                    <h2 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)' }}>{tile.roomIcon} {tile.roomName}</h2>
                    <button className="configure-btn" onClick={() => { setDetailTileId(null); openRoomConfig(tile.id) }} style={{ marginLeft: 'auto' }}>⚙️ Config</button>
                </div>

                <div className="device-list-scroller" style={{ padding: '0 4px' }}>

                    {/* Climate Section */}
                    {climateDevices.length > 0 && (
                        <div className="detail-section">
                            <div className="detail-section-title">
                                <span>🌡️</span> Climate
                            </div>
                            <div className="detail-grid">
                                {climateDevices.map(renderCard)}
                            </div>
                        </div>
                    )}

                    {/* Covers Section */}
                    {covers.length > 0 && (
                        <div className="detail-section">
                            <div className="detail-section-title">
                                <span>🪟</span> Coverings
                            </div>
                            <div className="detail-grid">
                                {covers.map(renderCard)}
                            </div>
                        </div>
                    )}

                    {/* Controls Section (Lights/Switches/Locks/Media) */}
                    {controls.length > 0 && (
                        <div className="detail-section">
                            <div className="detail-section-title">
                                <span>⚡</span> Controls
                            </div>
                            <div className="detail-grid">
                                {controls.map(renderCard)}
                            </div>
                        </div>
                    )}

                    {/* Sensors Section */}
                    {sensors.length > 0 && (
                        <div className="detail-section">
                            <div className="detail-section-title">
                                <span>👁️</span> Sensors
                            </div>
                            <div className="detail-grid">
                                {sensors.map(renderCard)}
                            </div>
                        </div>
                    )}

                    {!climateDevices.length && !covers.length && !controls.length && !sensors.length && (
                        <div style={{ textAlign: 'center', opacity: 0.5, marginTop: 40 }}>
                            No devices found in this room.
                        </div>
                    )}
                </div>
            </div>
        )
    }

    useImperativeHandle(ref, () => ({
        importLayoutFromHA
    }))


    if (detailTileId) {
        return (
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', flex: 1, height: '100%', overflow: 'hidden' }}>
                {renderDetailView()}

                {/* Inspector Modal */}
                {inspectorData && (
                    <div className="modal-overlay" onClick={() => setInspectorData(null)}>
                        <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
                            <div className="modal-header">
                                <h2>{inspectorData.name} Details</h2>
                                <button onClick={() => setInspectorData(null)}>✕</button>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                {inspectorData.diagnostics.length === 0 ? (
                                    <div style={{ opacity: 0.5, textAlign: 'center' }}>No diagnostics available.</div>
                                ) : (
                                    inspectorData.diagnostics.map(d => {
                                        const ha = entityStates[d.entityId || '']
                                        if (!ha) return null
                                        let val = ha.state
                                        if (ha.attributes?.unit_of_measurement) val += ` ${ha.attributes.unit_of_measurement}`

                                        return (
                                            <div key={d.id} className="device-row">
                                                <div style={{ flex: 1 }}>
                                                    <div className="device-name">{d.entityId}</div>
                                                    <div className="device-state" style={{ fontSize: '0.9rem', color: 'var(--accent)' }}>{val}</div>
                                                </div>
                                            </div>
                                        )
                                    })
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        )
    }

    // Live search across ALL Home Assistant devices & entities (with NL<->EN appliance matching!)
    const normalizedSearch = searchQuery.trim().toLowerCase()
    const searchMatches = normalizedSearch.length >= 2 ? (() => {
        const synonyms: Record<string, string[]> = {
            wasmachine: ['washer', 'washing', 'was'],
            droogkast: ['dryer', 'droger', 'tumble'],
            droger: ['dryer', 'droogkast', 'tumble'],
            vaatwasser: ['dishwasher'],
            koelkast: ['fridge', 'refrigerator'],
            vriezer: ['freezer'],
            verwarming: ['climate', 'thermostat', 'heat'],
            rolluik: ['cover', 'shutter', 'blind'],
            gordijn: ['cover', 'curtain', 'blind'],
            laadpaal: ['charger', 'wallbox', 'ev'],
            zonnepanelen: ['solar', 'inverter', 'omvormer', 'pv'],
            lamp: ['light', 'licht'],
            licht: ['light', 'lamp']
        }
        const terms = [normalizedSearch, ...(synonyms[normalizedSearch] || [])]
        const devById = new Map<string, any>()
        ;(haDevices || []).forEach((d: any) => { if (d?.id) devById.set(d.id, d) })
        const regByEid = new Map<string, any>()
        ;(haEntitiesRegistry || []).forEach((e: any) => { if (e?.entity_id) regByEid.set(e.entity_id, e) })

        return availableEntities.filter(ent => {
            const reg = regByEid.get(ent.entity_id)
            const dev = reg?.device_id ? devById.get(reg.device_id) : null
            const haystack = `${ent.entity_id} ${ent.friendly_name} ${dev?.name_by_user || ''} ${dev?.name || ''} ${dev?.manufacturer || ''} ${dev?.model || ''}`.toLowerCase()
            return terms.some(t => haystack.includes(t))
        }).slice(0, 40)
    })() : []

    return (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
            {/* Top Bar + Quick Search */}
            <div className="dashboard-header" style={{ flexWrap: 'wrap', gap: '10px' }}>
                <div>
                    <h1>Home</h1>
                    <div className="connection-status">
                        <span className={`status-dot ${activeConnection ? 'connected' : ''}`}></span>
                        {activeConnection
                            ? `${activeConnection.name} • ${availableEntities.length} entiteiten`
                            : 'Disconnected'}
                    </div>
                </div>
                {activeConnection && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 220px', maxWidth: '380px', marginLeft: 'auto' }}>
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="🔍 Zoek apparaat (bv. wasmachine, droogkast)..."
                            style={{
                                width: '100%',
                                padding: '8px 12px',
                                borderRadius: '10px',
                                border: '1px solid var(--border, rgba(255,255,255,0.12))',
                                background: 'rgba(255,255,255,0.05)',
                                color: 'var(--text-primary, #ffffff)',
                                fontSize: '0.84rem',
                                outline: 'none'
                            }}
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={() => setSearchQuery('')}
                                style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1rem', padding: '4px' }}
                            >
                                ✕
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Instant Search Results */}
            {normalizedSearch.length >= 2 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '0 4px' }}>
                        {searchMatches.length} resultaten voor &ldquo;{searchQuery}&rdquo;
                    </div>
                    {searchMatches.length === 0 ? (
                        <div style={{ padding: '24px', textAlign: 'center', opacity: 0.65, fontSize: '0.88rem' }}>
                            Geen apparaten of sensoren gevonden voor &ldquo;{searchQuery}&rdquo;.
                        </div>
                    ) : (
                        searchMatches.map(ent => {
                            const domain = ent.entity_id.split('.')[0]
                            const isToggleable = ['light', 'switch', 'input_boolean', 'lock', 'media_player', 'cover', 'fan', 'vacuum', 'humidifier'].includes(domain)
                            const isTriggerable = ['button', 'scene', 'script'].includes(domain)
                            const isActive = ent.state === 'on' || ent.state === 'playing' || ent.state === 'open' || ent.state === 'running'
                            const typeDef = DEVICE_TYPES.find(dt => dt.domain === domain) || { icon: '👁️' }
                            const icon = getApplianceIcon(`${ent.friendly_name} ${ent.entity_id}`, typeDef.icon)
                            const val = ent.attributes?.unit_of_measurement ? `${ent.state} ${ent.attributes.unit_of_measurement}` : ent.state

                            return (
                                <div
                                    key={ent.entity_id}
                                    className="entity-row"
                                    style={{
                                        background: 'var(--bg-card)',
                                        border: '1px solid var(--border)',
                                        borderRadius: '12px',
                                        padding: '10px 14px'
                                    }}
                                >
                                    <div className="entity-main" style={{ minWidth: 0 }}>
                                        <div className={`entity-icon ${isActive ? 'active' : ''}`}>{icon}</div>
                                        <div style={{ minWidth: 0 }}>
                                            <div className="entity-name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                {ent.friendly_name}
                                            </div>
                                            <div style={{ fontSize: '0.72rem', opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                {ent.entity_id}
                                            </div>
                                        </div>
                                    </div>
                                    {isToggleable ? (
                                        <div
                                            className={`toggle-switch compact ${isActive ? 'on' : ''}`}
                                            onClick={() => handleToggle(ent.entity_id, ent.state)}
                                        />
                                    ) : isTriggerable ? (
                                        <button
                                            type="button"
                                            onClick={() => handleToggle(ent.entity_id, ent.state)}
                                            style={{ padding: '4px 10px', borderRadius: '8px', background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', color: '#a5b4fc', cursor: 'pointer', fontSize: '0.78rem' }}
                                        >
                                            ▶
                                        </button>
                                    ) : (
                                        <div className="entity-state">{val}</div>
                                    )}
                                </div>
                            )
                        })
                    )}
                </div>
            ) : tiles.length === 0 ? (
                <div style={{
                    padding: '40px 24px',
                    textAlign: 'center',
                    background: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: '16px',
                    border: '1px dashed rgba(255, 255, 255, 0.15)',
                    margin: '20px 0'
                }}>
                    <div style={{ fontSize: '2.8rem', marginBottom: '14px' }}>🏡</div>
                    <h3 style={{ margin: '0 0 8px 0', fontSize: '1.25rem', fontWeight: 600 }}>
                        {availableEntities.length > 0 ? 'Apparaten klaar om te laden' : 'Woning in opbouw'}
                    </h3>
                    <p style={{ margin: '0 auto 18px auto', opacity: 0.75, fontSize: '0.92rem', lineHeight: '1.6', maxWidth: '420px' }}>
                        {availableEntities.length > 0
                            ? `${availableEntities.length} Home Assistant entiteiten gedetecteerd. Tik op de knop hieronder om alle kamers en apparaten direct te importeren.`
                            : 'Er zijn nog geen kamers of apparaten geladen vanuit Home Assistant. Tik hieronder om te synchroniseren.'}
                    </p>
                    {activeConnection && (
                        <button
                            type="button"
                            disabled={isSyncingLayout}
                            onClick={() => importLayoutFromHA()}
                            style={{
                                padding: '10px 18px',
                                borderRadius: '10px',
                                background: '#4f46e5',
                                color: '#ffffff',
                                border: 'none',
                                fontWeight: 600,
                                fontSize: '0.9rem',
                                cursor: isSyncingLayout ? 'wait' : 'pointer'
                            }}
                        >
                            {isSyncingLayout ? '⏳ Synchroniseren...' : '↻ Synchroniseer met Home Assistant'}
                        </button>
                    )}
                </div>
            ) : (
                <div className="room-grid">
                    {[...tiles].sort((a, b) => a.order - b.order).map(tile => renderRoomCard(tile))}

                    {/* Add Room Button */}
                    {editMode && (
                        <div className="room-card add-room" onClick={() => setShowAddRoomModal(true)}>
                            <div style={{ fontSize: '2rem' }}>+</div>
                            <div>Add Room</div>
                        </div>
                    )}
                </div>
            )}

            {/* Config Modal */}
            {configTileId && (
                <div className="modal-overlay" onClick={() => setConfigTileId(null)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Configure Room</h2>
                            <button onClick={() => setConfigTileId(null)}>✕</button>
                        </div>

                        {!editingDevice ? (
                            <>
                                <div className="device-list">
                                    <h3>Devices</h3>
                                    {tiles.find(t => t.id === configTileId)?.deviceGroups.flatMap(g =>
                                        g.entities.map(device => ({ groupId: g.id, device }))
                                    ).map(({ groupId, device }) => (
                                        <div key={`${groupId}-${device.id}`} className="device-row">
                                            <span>{device.icon} {device.name}</span>
                                            <div>
                                                <button onClick={() => {
                                                    setEditingDevice(device)
                                                    setSelectedEntityId(device.entityId || '')
                                                }}>Edit</button>
                                                <button className="delete-btn" onClick={() => removeDevice(configTileId, groupId, device.id)}>Remove</button>
                                            </div>
                                        </div>
                                    ))}
                                    {(!tiles.find(t => t.id === configTileId)?.deviceGroups.length) && <p>No devices.</p>}
                                </div>
                                <div className="modal-actions">
                                    <button className="primary-btn" onClick={() => setShowDevicePicker(true)}>+ Add Device</button>
                                </div>
                            </>
                        ) : (
                            <div className="device-editor">
                                <div className="form-group">
                                    <label>Name</label>
                                    <input value={editingDevice.name} onChange={e => setEditingDevice({ ...editingDevice, name: e.target.value })} />
                                </div>
                                <div className="form-group">
                                    <label>Entity ID</label>
                                    <select value={selectedEntityId} onChange={e => setSelectedEntityId(e.target.value)}>
                                        <option value="">Select Entity...</option>
                                        {availableEntities.sort((a, b) => a.entity_id.localeCompare(b.entity_id)).map(e => (
                                            <option key={e.entity_id} value={e.entity_id}>
                                                {e.friendly_name} ({e.entity_id})
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="modal-actions">
                                    <button onClick={() => setEditingDevice(null)}>Cancel</button>
                                    <button className="primary-btn" onClick={saveDevice}>Save</button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Device Type Picker */}
            {showDevicePicker && (
                <div className="modal-overlay" onClick={() => setShowDevicePicker(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <h3>Select Device Type</h3>
                        <div className="device-type-grid">
                            {DEVICE_TYPES.map(type => (
                                <div key={type.id} className="device-type-card" onClick={() => handleAddDevice(type)}>
                                    <div style={{ fontSize: '2rem' }}>{type.icon}</div>
                                    <div>{type.name}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

            )}

            {/* Add Room Modal */}
            {showAddRoomModal && (
                <div className="modal-overlay" onClick={() => setShowAddRoomModal(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <h3>Add New Room</h3>
                        <input
                            placeholder="Room Name"
                            value={newRoomName}
                            onChange={e => setNewRoomName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAddRoom()}
                        />
                        <div className="modal-actions">
                            <button onClick={() => setShowAddRoomModal(false)}>Cancel</button>
                            <button className="primary-btn" onClick={handleAddRoom}>Add</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Toast Notification */}
            {toastMsg && (
                <div className="toast-notification">
                    {toastMsg}
                </div>
            )}

            {/* Suggestion Review Modal */}
            {headerSuggestions.length > 0 && (
                <SuggestionPopup
                    suggestions={headerSuggestions}
                    onClose={() => setHeaderSuggestions([])}
                    onAction={handleSuggestionAction}
                />
            )}
        </div>
    )
})
