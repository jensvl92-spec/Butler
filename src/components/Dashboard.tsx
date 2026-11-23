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
    platform?: string
    isDiagnostic?: boolean
}

// Device Group (The actual "Device" in HA terms)
interface DeviceGroup {
    id: string
    name: string
    manufacturer?: string
    model?: string
    platform?: string
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
    deviceGroups: DeviceGroup[]
}

function resolveRoomIcon(roomName?: string, existing?: string): string {
    if (existing && existing !== 'not_found') return existing
    const lower = (roomName || '').toLowerCase()
    return Object.entries(ROOM_ICONS).find(([k]) => k !== 'default' && lower.includes(k))?.[1] || ROOM_ICONS.default
}

function normalizeStoredTiles(raw: any): DashboardTile[] {
    if (!Array.isArray(raw)) return []
    return raw.map((tile: any, idx: number) => {
        const roomName = tile?.roomName || 'Room'
        const roomIcon = resolveRoomIcon(roomName, tile?.roomIcon)
        if (Array.isArray(tile?.deviceGroups)) {
            return { ...tile, roomIcon, order: typeof tile.order === 'number' ? tile.order : idx }
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
            roomName,
            roomIcon,
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
    { id: 'water_heater', name: 'Boiler', icon: '🔥', description: 'Water heaters', domain: 'water_heater' },
    { id: 'humidifier', name: 'Humidifier', icon: '💧', description: 'Humidifiers', domain: 'humidifier' },
    { id: 'media', name: 'Media', icon: '📺', description: 'TV and media players', domain: 'media_player' },
    { id: 'cover', name: 'Blinds/Cover', icon: '🪟', description: 'Curtains and blinds', domain: 'cover' },
    { id: 'lock', name: 'Lock', icon: '🔒', description: 'Smart locks', domain: 'lock' },
    { id: 'valve', name: 'Valve', icon: '🚰', description: 'Smart valves', domain: 'valve' },
    { id: 'alarm_control_panel', name: 'Alarm', icon: '🛡️', description: 'Alarm panels', domain: 'alarm_control_panel' },
    { id: 'siren', name: 'Siren', icon: '🚨', description: 'Sirens', domain: 'siren' },
    { id: 'fan', name: 'Fan', icon: '🌀', description: 'Fans and ventilation', domain: 'fan' },
    { id: 'vacuum', name: 'Vacuum', icon: '🤖', description: 'Robot vacuums', domain: 'vacuum' },
    { id: 'lawn_mower', name: 'Mower', icon: '🌿', description: 'Robot lawn mowers', domain: 'lawn_mower' },
    { id: 'remote', name: 'Remote', icon: '📱', description: 'Remotes', domain: 'remote' },
    { id: 'camera', name: 'Camera', icon: '📷', description: 'Security cameras', domain: 'camera' },
    { id: 'button', name: 'Button', icon: '🔘', description: 'Action buttons', domain: 'button' },
    { id: 'input_button', name: 'Input Button', icon: '🔘', description: 'Helper buttons', domain: 'input_button' },
    { id: 'select', name: 'Select', icon: '🎛️', description: 'Mode & program selectors', domain: 'select' },
    { id: 'input_select', name: 'Input Select', icon: '🎛️', description: 'Helper selectors', domain: 'input_select' },
    { id: 'number', name: 'Number', icon: '🎚️', description: 'Numeric controls', domain: 'number' },
    { id: 'input_number', name: 'Input Number', icon: '🎚️', description: 'Helper numbers', domain: 'input_number' },
    { id: 'input_boolean', name: 'Toggle', icon: '🔘', description: 'Helper toggles', domain: 'input_boolean' },
    { id: 'input_text', name: 'Text', icon: '📝', description: 'Helper text', domain: 'input_text' },
    { id: 'input_datetime', name: 'Date/Time', icon: '🕒', description: 'Helper date/time', domain: 'input_datetime' },
    { id: 'scene', name: 'Scene', icon: '✨', description: 'Scenes', domain: 'scene' },
    { id: 'script', name: 'Script', icon: '⚡', description: 'Scripts', domain: 'script' },
    { id: 'automation', name: 'Automation', icon: '🤖', description: 'Automations', domain: 'automation' },
    { id: 'todo', name: 'To-Do', icon: '✅', description: 'To-do lists', domain: 'todo' },
    { id: 'calendar', name: 'Calendar', icon: '📅', description: 'Calendars', domain: 'calendar' },
    { id: 'weather', name: 'Weather', icon: '🌤️', description: 'Weather forecasts', domain: 'weather' },
    { id: 'person', name: 'Person', icon: '👤', description: 'Presence', domain: 'person' },
    { id: 'device_tracker', name: 'Tracker', icon: '📍', description: 'Device trackers', domain: 'device_tracker' },
    { id: 'timer', name: 'Timer', icon: '⏱️', description: 'Timers', domain: 'timer' },
    { id: 'binary_sensor', name: 'Binary Sensor', icon: '📡', description: 'Status & contact sensors', domain: 'binary_sensor' },
    { id: 'sensor', name: 'Sensor', icon: '👁️', description: 'Read-only sensors', domain: 'sensor' },
]

function getApplianceIcon(name: string, fallbackIcon: string): string {
    const n = (name || '').toLowerCase()
    if (n.includes('wasmachine') || n.includes('washer') || n.includes('washing')) return '🫧'
    if (n.includes('droogkast') || n.includes('droger') || n.includes('dryer') || n.includes('tumble')) return '💨'
    if (n.includes('vaatwasser') || n.includes('dishwasher')) return '🍽️'
    if (n.includes('koelkast') || n.includes('fridge') || n.includes('vriezer') || n.includes('freezer')) return '🧊'
    if (n.includes('oven') || n.includes('kookplaat') || n.includes('fornuis') || n.includes('microgolf') || n.includes('microwave')) return '🔥'
    if (n.includes('laadpaal') || n.includes('charger') || n.includes('wallbox') || n.includes('ev ')) return '🔋'
    if (n.includes('zonnepanelen') || n.includes('solar') || n.includes('omvormer') || n.includes('inverter')) return '☀️'
    if (n.includes('warmtepomp') || n.includes('airco') || n.includes('hvac')) return '🌡️'
    if (n.includes('printer') || n.includes('brother') || n.includes('epson') || n.includes('laserjet') || n.includes('officejet') || n.includes('deskjet') || n.includes('pixma') || n.includes('toner')) return '🖨️'
    if (n.includes('stofzuiger') || n.includes('vacuum') || n.includes('roborock') || n.includes('deebot') || n.includes('ecovacs') || n.includes('roomba') || n.includes('dreame')) return '🤖'
    return fallbackIcon
}

/** Strips redundant device-name prefix from a sub-entity label (e.g. "Droogkast Programma" -> "Programma") */
function getCleanSubEntityName(entityName: string, deviceName: string): string {
    const raw = (entityName || '').trim()
    const dev = (deviceName || '').trim()
    if (!raw || !dev || raw.toLowerCase() === dev.toLowerCase()) return raw || dev
    const lowerRaw = raw.toLowerCase()
    const lowerDev = dev.toLowerCase()
    if (lowerRaw.startsWith(lowerDev)) {
        const stripped = raw.slice(dev.length).replace(/^[\s\-_:–—]+/, '').trim()
        if (stripped.length > 0) {
            return stripped.charAt(0).toUpperCase() + stripped.slice(1)
        }
    }
    return raw
}

/** Formats HA state strings cleanly for Dutch UI */
function formatHAStateLabel(state: string, attributes?: Record<string, any>, entityId?: string): string {
    if (state === undefined || state === null || state === '') return 'Onbekend'
    const s = String(state)
    const lower = s.toLowerCase()
    if (lower === 'unavailable') return 'Niet beschikbaar'
    if (lower === 'unknown') return 'Onbekend'

    const eid = (entityId || '').toLowerCase()
    const dc = (attributes?.device_class || '').toLowerCase()
    if (dc === 'door' || dc === 'window' || dc === 'garage_door' || dc === 'opening' || eid.includes('door') || eid.includes('deur') || eid.includes('window') || eid.includes('raam')) {
        if (lower === 'on') return 'Open'
        if (lower === 'off') return 'Dicht'
    }
    if (dc === 'motion' || dc === 'occupancy' || dc === 'presence') {
        if (lower === 'on') return 'Actief'
        if (lower === 'off') return 'Rustig'
    }
    if (dc === 'running' || dc === 'power' || dc === 'plug') {
        if (lower === 'on') return 'Actief'
        if (lower === 'off') return 'Uit'
    }
    if (lower === 'on') return 'Aan'
    if (lower === 'off') return 'Uit'
    if (lower === 'open') return 'Open'
    if (lower === 'closed') return 'Dicht'
    if (lower === 'locked') return 'Vergrendeld'
    if (lower === 'unlocked') return 'Ontgrendeld'
    if (lower === 'idle' || lower === 'standby') return 'Stand-by'
    if (lower === 'running' || lower === 'active') return 'Bezig'
    if (lower === 'paused') return 'Gepauzeerd'
    if (lower === 'finished' || lower === 'complete' || lower === 'completed') return 'Klaar'
    if (lower === 'docked') return 'Gedockt'
    if (lower === 'cleaning') return 'Stofzuigen'
    if (lower === 'returning') return 'Naar basis'
    if (lower === 'charging') return 'Opladen'
    if (lower === 'error') return 'Storing'

    let formatted = s.replace(/_/g, ' ')
    if (attributes?.unit_of_measurement) {
        return `${formatted} ${attributes.unit_of_measurement}`
    }
    if (formatted.length < 32 && /^[a-z]/.test(formatted)) {
        formatted = formatted.charAt(0).toUpperCase() + formatted.slice(1)
    }
    return formatted
}

export const Dashboard = forwardRef<DashboardRef>((_props, ref) => {
    const { activeConnection, entityStates, haWebSocket, rooms, haAreas, haDevices, haEntitiesRegistry, haSyncSource, haLastError, refreshHAFromServer } = useApp()

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

    // 3-Tier Navigation State: Home -> Room (detailTileId) -> Device Control Sheet (selectedDevice)
    const [detailTileId, setDetailTileId] = useState<string | null>(null)
    const [selectedDevice, setSelectedDevice] = useState<{
        tileId: string | null
        roomName: string
        groupId: string
        fallbackGroup?: DeviceGroup
    } | null>(null)
    const [showDiagnostics, setShowDiagnostics] = useState(false)

    const [inspectorData, setInspectorData] = useState<{ name: string, diagnostics: RoomDevice[] } | null>(null)

    // Suggestion State
    const [headerSuggestions, setHeaderSuggestions] = useState<Suggestion[]>([])

    // Track which connection's tiles are currently loaded to prevent cross-connection overwrite on switch
    const loadedConnectionIdRef = useRef<string | null>(null)
    const lastSyncedSigRef = useRef<string>('')

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

            if (domain === 'light' || domain === 'switch' || domain === 'input_boolean' || domain === 'fan' || domain === 'humidifier' || domain === 'siren' || domain === 'remote') {
                service = 'toggle'
            } else if (domain === 'button' || domain === 'input_button') {
                service = 'press'
            } else if (domain === 'scene') {
                service = 'turn_on'
            } else if (domain === 'vacuum') {
                service = currentState === 'cleaning' ? 'return_to_base' : 'start'
            } else if (domain === 'lawn_mower') {
                service = currentState === 'mowing' ? 'dock' : 'start_mowing'
            } else if (domain === 'automation') {
                service = 'trigger'
            } else if (domain === 'script') {
                service = 'turn_on'
            } else if (domain === 'media_player') {
                service = 'media_play_pause'
            } else if (domain === 'cover') {
                service = currentState === 'closed' ? 'open_cover' : 'close_cover'
            } else if (domain === 'valve') {
                service = currentState === 'closed' ? 'open_valve' : 'close_valve'
            } else if (domain === 'lock') {
                service = currentState === 'locked' ? 'unlock' : 'lock'
            }

            await callHAService(domain, service, serviceData, activeConnection.api_url, activeConnection.api_token)
            console.log(`✅ Toggle Sent: ${domain}.${service}`)
            setToastMsg(`✅ ${service.replace(/_/g, ' ')}`)
            setTimeout(() => setToastMsg(null), 1800)

        } catch (error: any) {
            console.error('Toggle Error:', error)
            setToastMsg(`❌ ${error.message || 'Actie mislukt'}`)
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
            await callHAService('cover', service, { entity_id: entityId }, activeConnection.api_url, activeConnection.api_token)
            setToastMsg(`🪟 ${action === 'open' ? 'Openen' : action === 'close' ? 'Sluiten' : 'Gestopt'}`)
            setTimeout(() => setToastMsg(null), 1800)
        } catch (error: any) {
            setToastMsg(`❌ ${error.message}`)
            setTimeout(() => setToastMsg(null), 3000)
        }
    }

    const handleSelectOption = async (entityId: string, option: string) => {
        if (!entityId || !activeConnection) return
        const domain = entityId.startsWith('input_select.') ? 'input_select' : 'select'
        try {
            await callHAService(domain, 'select_option', { entity_id: entityId, option }, activeConnection.api_url, activeConnection.api_token)
            setToastMsg(`🎛️ Gekozen: ${option.replace(/_/g, ' ')}`)
            setTimeout(() => setToastMsg(null), 1800)
        } catch (error: any) {
            setToastMsg(`❌ ${error.message || 'Selectie mislukt'}`)
            setTimeout(() => setToastMsg(null), 3000)
        }
    }

    const handleNumberValue = async (entityId: string, value: number) => {
        if (!entityId || !activeConnection) return
        const domain = entityId.startsWith('input_number.') ? 'input_number' : 'number'
        try {
            await callHAService(domain, 'set_value', { entity_id: entityId, value }, activeConnection.api_url, activeConnection.api_token)
            setToastMsg(`🎚️ Ingesteld op ${value}`)
            setTimeout(() => setToastMsg(null), 1800)
        } catch (error: any) {
            setToastMsg(`❌ ${error.message || 'Instellen mislukt'}`)
            setTimeout(() => setToastMsg(null), 3000)
        }
    }

    const handleClimateMode = async (entityId: string, hvacMode: string) => {
        if (!entityId || !activeConnection) return
        try {
            await callHAService('climate', 'set_hvac_mode', { entity_id: entityId, hvac_mode: hvacMode }, activeConnection.api_url, activeConnection.api_token)
            setToastMsg(`🌡️ Modus: ${hvacMode}`)
            setTimeout(() => setToastMsg(null), 1800)
        } catch (error: any) {
            setToastMsg(`❌ ${error.message || 'Modus wijzigen mislukt'}`)
            setTimeout(() => setToastMsg(null), 3000)
        }
    }

    const handleMediaAction = async (entityId: string, service: string, extraData?: Record<string, any>) => {
        if (!entityId || !activeConnection) return
        try {
            await callHAService('media_player', service, { entity_id: entityId, ...(extraData || {}) }, activeConnection.api_url, activeConnection.api_token)
        } catch (error: any) {
            setToastMsg(`❌ ${error.message || 'Media actie mislukt'}`)
            setTimeout(() => setToastMsg(null), 2500)
        }
    }

    const handleVacuumAction = async (entityId: string, service: string, extraData?: Record<string, any>) => {
        if (!entityId || !activeConnection) return
        try {
            await callHAService('vacuum', service, { entity_id: entityId, ...(extraData || {}) }, activeConnection.api_url, activeConnection.api_token)
            const labels: Record<string, string> = {
                start: '🤖 Stofzuigen gestart',
                pause: '⏸️ Gepauzeerd',
                stop: '⏹️ Gestopt',
                return_to_base: '🏠 Terug naar laadstation',
                locate: '📍 Robot laat zich horen',
                set_fan_speed: `💨 Zuigkracht: ${extraData?.fan_speed || ''}`
            }
            setToastMsg(labels[service] || `🤖 ${service.replace(/_/g, ' ')}`)
            setTimeout(() => setToastMsg(null), 2200)
        } catch (error: any) {
            setToastMsg(`❌ ${error.message || 'Robotstofzuiger actie mislukt'}`)
            setTimeout(() => setToastMsg(null), 3000)
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

        const INTERACTIVE_CONTROL_DOMAINS = new Set([
            'light', 'switch', 'input_boolean', 'select', 'input_select', 'button', 'input_button',
            'number', 'input_number', 'climate', 'water_heater', 'cover', 'lock', 'valve', 'fan',
            'humidifier', 'vacuum', 'lawn_mower', 'media_player', 'siren', 'remote', 'scene', 'script',
            'alarm_control_panel'
        ])

        const isDiagEntity = (entityId: string, entityCategory?: string) => {
            const domain = (entityId || '').split('.')[0].toLowerCase()
            const lower = (entityId || '').toLowerCase()
            // Never bury interactive controls (like program/cycle selects, switches, buttons, numbers)
            // inside read-only diagnostics just because HA marked them entity_category="config"!
            if (INTERACTIVE_CONTROL_DOMAINS.has(domain)) {
                if (entityCategory === 'diagnostic') {
                    // Only rare diagnostic-only buttons like "identify" / "reboot" stay in diagnostics
                    return lower.includes('_identify') || lower.includes('_reboot') || lower.includes('_restart')
                }
                return false
            }
            // User-relevant consumables (printer toner/ink/cartridge/drum, dishwasher salt/rinse aid, filter life)
            // are marked "diagnostic" by HA integrations (IPP/Brother/HP) but should be visible when tapping the device!
            if (/(?:^|_)(toner|ink|inkt|cartridge|drum|salt|rinse_aid|filter_life)(?:_|$)/.test(lower)) {
                return false
            }
            if (entityCategory === 'diagnostic' || entityCategory === 'config') return true
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
            const st = String(statesMap[e.entityId || '']?.state ?? '').toLowerCase()
            const unavailablePenalty = (!st || st === 'unavailable' || st === 'unknown') ? -25 : 0
            if (e.isDiagnostic) return -10 + unavailablePenalty
            let base = 1
            if (eid.startsWith('vacuum.') || eid.startsWith('lawn_mower.')) base = 22
            else if (eid.startsWith('light.')) base = 20
            else if (eid.startsWith('climate.') || eid.startsWith('water_heater.')) base = 19
            else if (eid.startsWith('cover.')) base = 18
            else if (eid.startsWith('switch.')) base = 17
            else if (eid.startsWith('lock.')) base = 16
            else if (eid.startsWith('fan.') || eid.startsWith('humidifier.')) base = 15
            else if (eid.startsWith('media_player.')) base = 14
            else if (eid.startsWith('sensor.')) {
                if (/operation_state|machine_state|status|state|phase|program|programma|remaining|resterend|progress|cycle/.test(eid)) base = 12
                else if (/power|watt|energy|temp/.test(eid)) base = 6
                else base = 4
            } else if (eid.startsWith('binary_sensor.')) {
                if (/door|deur|window|raam|running|active|motion|occupancy/.test(eid)) base = 8
                else base = 3
            } else if (eid.startsWith('select.') || eid.startsWith('button.') || eid.startsWith('number.')) {
                base = 7
            }
            return base + unavailablePenalty
        }

        // Pre-populate tiles with all HA areas
        if (Array.isArray(areasList) && areasList.length > 0) {
            areasList.forEach(area => {
                if (area?.area_id) getOrCreateTile(area.area_id, area.name || area.area_id)
            })
        }

        const coveredEntityIds = new Set<string>()
        const deviceMap = new Map<string, DeviceGroup>()

        // Helper: smart heuristic clustering for loose entities (orphans / REST-only fallback)
        // so a dryer or washer with 15 entities NEVER explodes into 15 flat rows even if device_id is missing!
        const clusterLooseEntitiesIntoTile = (
            tile: DashboardTile,
            looseItems: Array<{ ent: RoomDevice; rawName: string; platform?: string }>
        ) => {
            if (looseItems.length === 0) return

            // Try matching against existing real devices in the same room first (by device name prefix!)
            const remaining: typeof looseItems = []
            looseItems.forEach(item => {
                const lowerName = item.rawName.toLowerCase()
                const objId = (item.ent.entityId || '').split('.')[1] || ''
                const matchedGroup = tile.deviceGroups.find(g => {
                    const gName = (g.name || '').toLowerCase().trim()
                    if (gName.length < 4) return false
                    const gSlug = gName.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
                    return lowerName.startsWith(`${gName} `) || (gSlug.length >= 4 && objId.startsWith(`${gSlug}_`))
                })
                if (matchedGroup) {
                    matchedGroup.entities.push(item.ent)
                    matchedGroup.entities.sort((a, b) => scorePrimaryEntity(b) - scorePrimaryEntity(a))
                    matchedGroup.primaryEntity = matchedGroup.entities[0]
                } else {
                    remaining.push(item)
                }
            })

            if (remaining.length === 0) return

            // Group remaining loose entities that share a common 2-token object_id prefix (e.g. "samsung_dryer_*" or "droogkast_*")
            const prefixCounts = new Map<string, number>()
            const candidateKeyFor = (eid: string): string => {
                const obj = (eid.split('.')[1] || '').toLowerCase()
                const parts = obj.split('_').filter(Boolean)
                if (parts.length >= 3) return `${parts[0]}_${parts[1]}`
                if (parts.length === 2 && parts[0].length >= 5) return parts[0]
                return ''
            }
            remaining.forEach(item => {
                const key = candidateKeyFor(item.ent.entityId || '')
                if (key) prefixCounts.set(key, (prefixCounts.get(key) || 0) + 1)
            })

            const clusters = new Map<string, Array<{ ent: RoomDevice; rawName: string; platform?: string }>>()
            const singles: typeof remaining = []

            remaining.forEach(item => {
                const key = candidateKeyFor(item.ent.entityId || '')
                if (key && (prefixCounts.get(key) || 0) >= 2) {
                    if (!clusters.has(key)) clusters.set(key, [])
                    clusters.get(key)!.push(item)
                } else {
                    singles.push(item)
                }
            })

            clusters.forEach((items, prefixKey) => {
                const entities = items.map(it => it.ent).sort((a, b) => scorePrimaryEntity(b) - scorePrimaryEntity(a))
                // Derive human-friendly device title from common word prefix of friendly names
                const splitWords = items.map(it => it.rawName.trim().split(/\s+/))
                const commonWords: string[] = []
                for (let wi = 0; wi < (splitWords[0]?.length || 0); wi++) {
                    const w = splitWords[0][wi]
                    if (splitWords.every(sw => sw[wi] && sw[wi].toLowerCase() === w.toLowerCase())) {
                        commonWords.push(w)
                    } else {
                        break
                    }
                }
                const derivedName = commonWords.length > 0
                    ? commonWords.join(' ')
                    : prefixKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                const platform = items.find(it => it.platform)?.platform

                tile.deviceGroups.push({
                    id: `cluster-${tile.id}-${prefixKey}`,
                    name: derivedName,
                    platform,
                    areaId: tile.roomId,
                    primaryEntity: entities[0],
                    entities
                })
                devicesAddedCount++
            })

            singles.forEach(item => {
                tile.deviceGroups.push({
                    id: `orp-${item.ent.entityId}`,
                    name: item.rawName,
                    platform: item.platform,
                    areaId: tile.roomId,
                    primaryEntity: item.ent,
                    entities: [item.ent]
                })
                devicesAddedCount++
            })
        }

        // PATH A: Rich HA WebSocket / REST-Template Registries available
        if (Array.isArray(entitiesRegList) && entitiesRegList.length > 0) {
            const devById = new Map<string, any>()
            ;(devicesList || []).forEach(d => { if (d?.id) devById.set(d.id, d) })

            // CRITICAL: Mark ALL registry entity_ids (including hidden_by & disabled_by) as covered
            // so hidden/disabled HA entities NEVER leak back into the dashboard via PATH B!
            entitiesRegList.forEach(e => {
                if (e?.entity_id) coveredEntityIds.add(e.entity_id)
            })

            // NOTE: disabled_by may be null OR undefined — use !e.disabled_by!
            const activeRegistryEntities = entitiesRegList.filter(e => e?.entity_id && !e.hidden_by && !e.disabled_by)
            const orphans: any[] = []

            activeRegistryEntities.forEach(regEntity => {
                const liveState = statesMap[regEntity.entity_id]
                const domain = regEntity.entity_id.split('.')[0]
                const typeDef = DEVICE_TYPES.find(dt => dt.domain === domain) || { id: 'sensor', icon: '👁️', name: 'Sensor' }
                const friendlyName = regEntity.name || regEntity.original_name || liveState?.attributes?.friendly_name || regEntity.entity_id

                if (regEntity.device_id) {
                    const haDevice = devById.get(regEntity.device_id)
                    const identPlat = Array.isArray(haDevice?.identifiers) && Array.isArray(haDevice.identifiers[0])
                        ? haDevice.identifiers[0][0]
                        : undefined
                    const resolvedPlatform = regEntity.platform || haDevice?.platform || identPlat || undefined

                    if (!deviceMap.has(regEntity.device_id)) {
                        deviceMap.set(regEntity.device_id, {
                            id: regEntity.device_id,
                            name: haDevice?.name_by_user || haDevice?.name || friendlyName,
                            manufacturer: haDevice?.manufacturer,
                            model: haDevice?.model,
                            platform: resolvedPlatform,
                            areaId: haDevice?.area_id || regEntity.area_id,
                            entities: []
                        })
                    }
                    const group = deviceMap.get(regEntity.device_id)!
                    if (!group.platform && resolvedPlatform) group.platform = resolvedPlatform
                    group.entities.push({
                        id: `ent-${regEntity.entity_id}`,
                        type: typeDef.id,
                        name: friendlyName,
                        icon: getApplianceIcon(`${group.name} ${friendlyName}`, typeDef.icon),
                        entityId: regEntity.entity_id,
                        deviceId: regEntity.device_id,
                        platform: resolvedPlatform,
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

            // Cluster orphans per room (so even YAML/MQTT entities without device_id stay grouped!)
            const orphansByTile = new Map<DashboardTile, Array<{ ent: RoomDevice; rawName: string; platform?: string }>>()
            orphans.forEach(orp => {
                const domain = orp.entity_id.split('.')[0]
                if (domain === 'sun' || domain === 'zone' || domain === 'update' || domain === 'tts' || domain === 'stt' || domain === 'conversation' || domain === 'persistent_notification') return
                const liveState = statesMap[orp.entity_id]
                const typeDef = DEVICE_TYPES.find(dt => dt.domain === domain) || { id: 'sensor', icon: '👁️', name: 'Sensor' }
                const friendlyName = orp.name || orp.original_name || liveState?.attributes?.friendly_name || orp.entity_id
                const resolvedPlatform = orp.platform || undefined

                const ent: RoomDevice = {
                    id: `ent-${orp.entity_id}`,
                    type: typeDef.id,
                    name: friendlyName,
                    icon: getApplianceIcon(friendlyName, typeDef.icon),
                    entityId: orp.entity_id,
                    platform: resolvedPlatform,
                    isDiagnostic: isDiagEntity(orp.entity_id, orp.entity_category)
                }

                let tile: DashboardTile
                if (orp.area_id) {
                    const area = (areasList || []).find(a => a.area_id === orp.area_id)
                    tile = getOrCreateTile(orp.area_id, area?.name || orp.area_id)
                } else {
                    tile = unassignedTile
                }
                if (!orphansByTile.has(tile)) orphansByTile.set(tile, [])
                orphansByTile.get(tile)!.push({ ent, rawName: friendlyName, platform: resolvedPlatform })
            })
            orphansByTile.forEach((items, tile) => clusterLooseEntitiesIntoTile(tile, items))
        }

        // PATH B: Live entityStates not covered by registry (e.g. pure REST fallback or dynamic template entities)
        const liveEntries = Object.values(statesMap || {}).filter((s: any) => s?.entity_id && !coveredEntityIds.has(s.entity_id))
        if (liveEntries.length > 0) {
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

            const skipDomains = new Set(['sun', 'zone', 'update', 'tts', 'stt', 'conversation', 'persistent_notification'])
            const liveByTile = new Map<DashboardTile, Array<{ ent: RoomDevice; rawName: string; platform?: string }>>()
            liveEntries.forEach((s: any) => {
                const domain = s.entity_id.split('.')[0]
                if (skipDomains.has(domain)) return
                const typeDef = DEVICE_TYPES.find(dt => dt.domain === domain) || { id: 'sensor', icon: '👁️', name: 'Sensor' }
                const friendlyName = s.attributes?.friendly_name || s.entity_id
                const ent: RoomDevice = {
                    id: `ent-${s.entity_id}`,
                    type: typeDef.id,
                    name: friendlyName,
                    icon: getApplianceIcon(friendlyName, typeDef.icon),
                    entityId: s.entity_id,
                    isDiagnostic: isDiagEntity(s.entity_id)
                }

                const areaMatch = entityToArea.get(s.entity_id)
                const tile = areaMatch ? getOrCreateTile(areaMatch.id, areaMatch.name) : unassignedTile
                if (!liveByTile.has(tile)) liveByTile.set(tile, [])
                liveByTile.get(tile)!.push({ ent, rawName: friendlyName })
            })
            liveByTile.forEach((items, tile) => clusterLooseEntitiesIntoTile(tile, items))
        }

        if (unassignedTile.deviceGroups.length > 0) {
            newTiles.push(unassignedTile)
        }

        // Generic words that must NEVER merge separate lights/sensors/appliances together
        const GENERIC_FIRST_WORDS = new Set([
            'the', 'het', 'de', 'een', 'my', 'mijn',
            'living', 'woonkamer', 'salon', 'keuken', 'kitchen', 'badkamer', 'bathroom',
            'slaapkamer', 'bedroom', 'wasruimte', 'wasplaats', 'berging', 'garage', 'tuin', 'garden',
            'hal', 'gang', 'hall', 'inkom', 'bureau', 'office', 'zolder', 'kelder', 'buiten', 'terras',
            'lamp', 'lampen', 'light', 'lights', 'licht', 'lichten', 'spot', 'spots', 'led', 'strip',
            'switch', 'schakelaar', 'plug', 'stekker', 'stopcontact', 'socket', 'outlet',
            'sensor', 'temp', 'temperatuur', 'temperature', 'humidity', 'vocht', 'motion', 'beweging',
            'door', 'deur', 'window', 'raam', 'cover', 'rolluik', 'gordijn', 'curtain', 'blind',
            'climate', 'thermostaat', 'thermostat', 'heater', 'verwarming', 'airco', 'fan', 'ventilator',
            'camera', 'deurbel', 'doorbell', 'lock', 'slot', 'alarm', 'button', 'knop', 'scene', 'script',
            'samsung', 'philips', 'hue', 'shelly', 'aqara', 'sonos', 'google', 'apple', 'xiaomi',
            'tuya', 'zigbee', 'ikea', 'tradfri', 'esphome', 'tasmota', 'home', 'smart', 'mini', 'pro'
        ])

        const consolidateDeviceGroupsInTile = (tile: DashboardTile) => {
            if (!tile.deviceGroups || tile.deviceGroups.length <= 1) return

            const isLooseGroup = (g: DeviceGroup) =>
                g.id !== 'manual-group' && (
                    g.entities.length === 1 ||
                    g.id.startsWith('cluster-') ||
                    g.id.startsWith('orp-') ||
                    g.id.startsWith('grp-') ||
                    g.id.startsWith('live-') ||
                    g.id.startsWith('ent-') ||
                    g.id.startsWith('legacy-')
                )

            // Step 1: Merge any loose group whose name equals OR starts with an existing shorter device's name
            // in the same room (e.g. "Patje" + "Patje" + "Patje Reset" + "Patje Total" -> 1 single "Patje"!)
            // Prefer core control hosts (vacuum, climate, media, etc.) first, then shortest name.
            const isCoreHost = (g: DeviceGroup) =>
                ['vacuum', 'lawn_mower', 'climate', 'water_heater', 'media'].includes(g.primaryEntity?.type || '')
            const hostCandidates = [...tile.deviceGroups]
                .filter(g => g.id !== 'manual-group')
                .sort((a, b) => {
                    const coreDiff = (isCoreHost(b) ? 1 : 0) - (isCoreHost(a) ? 1 : 0)
                    if (coreDiff !== 0) return coreDiff
                    const lenDiff = (a.name || '').trim().length - (b.name || '').trim().length
                    if (lenDiff !== 0) return lenDiff
                    return b.entities.length - a.entities.length
                })

            const absorbedIds = new Set<string>()

            hostCandidates.forEach(host => {
                if (absorbedIds.has(host.id)) return
                const hName = (host.name || '').trim().toLowerCase()
                if (hName.length < 3 || GENERIC_FIRST_WORDS.has(hName)) return
                const isHostEligible =
                    host.entities.length > 1 ||
                    isCoreHost(host) ||
                    !hName.includes(' ')
                if (!isHostEligible) return

                tile.deviceGroups.forEach(g => {
                    if (g.id === host.id || absorbedIds.has(g.id) || !isLooseGroup(g)) return
                    const gLower = (g.name || '').trim().toLowerCase()
                    const isExactMatch = gLower === hName
                    const isPrefixMatch = gLower.startsWith(`${hName} `) || gLower.startsWith(`${hName}-`) || gLower.startsWith(`${hName}_`)
                    if (isExactMatch || isPrefixMatch) {
                        host.entities.push(...g.entities)
                        if (!host.platform && g.platform) host.platform = g.platform
                        absorbedIds.add(g.id)
                    }
                })
            })

            let working = tile.deviceGroups.filter(g => !absorbedIds.has(g.id))

            // Step 2: Consolidate 2+ loose groups sharing the same specific non-generic first word
            // (e.g., "Patje Active map", "Patje Reset", "Patje Total" -> 1 single "Patje"!)
            const roomTokens = new Set(
                (tile.roomName || '').toLowerCase().split(/[\s_-]+/).filter(Boolean)
            )
            const looseGroups = working.filter(isLooseGroup)
            const buckets = new Map<string, DeviceGroup[]>()

            looseGroups.forEach(g => {
                const words = (g.name || '').trim().split(/\s+/).filter(Boolean)
                if (words.length < 1) return
                const firstClean = words[0].toLowerCase().replace(/[^a-z0-9]/g, '')
                if (firstClean.length < 3 || GENERIC_FIRST_WORDS.has(firstClean) || roomTokens.has(firstClean)) return
                if (!buckets.has(firstClean)) buckets.set(firstClean, [])
                buckets.get(firstClean)!.push(g)
            })

            const mergedIds = new Set<string>()
            const newConsolidated: DeviceGroup[] = []

            buckets.forEach((groupList, firstKey) => {
                if (groupList.length < 2) return
                // Safety check: don't merge 2-3 separate simple lights like "Tafel links" & "Tafel rechts"
                const allLights = groupList.every(g => g.entities.every(e => e.type === 'light'))
                if (allLights && groupList.length < 4) return

                const allEntities: RoomDevice[] = []
                groupList.forEach(g => {
                    mergedIds.add(g.id)
                    allEntities.push(...g.entities)
                })
                allEntities.sort((a, b) => scorePrimaryEntity(b) - scorePrimaryEntity(a))

                // Use the nicely cased first word as clean device title (e.g. "Patje")
                const firstWordDisplay = (groupList[0].name || '').trim().split(/\s+/)[0] || firstKey
                const platform = groupList.find(g => g.platform)?.platform

                newConsolidated.push({
                    id: `consolidated-${tile.id}-${firstKey}`,
                    name: firstWordDisplay,
                    platform,
                    areaId: tile.roomId,
                    primaryEntity: allEntities[0],
                    entities: allEntities
                })
            })

            if (mergedIds.size > 0 || absorbedIds.size > 0) {
                working = [
                    ...working.filter(g => !mergedIds.has(g.id)),
                    ...newConsolidated
                ]
            }

            // Deduplicate entities inside each group & re-score primaryEntity so live available entities always lead!
            working.forEach(g => {
                const seenEids = new Set<string>()
                g.entities = g.entities.filter(e => {
                    const k = e.entityId || e.id
                    if (seenEids.has(k)) return false
                    seenEids.add(k)
                    return true
                })
                g.entities.sort((a, b) => scorePrimaryEntity(b) - scorePrimaryEntity(a))
                g.primaryEntity = g.entities[0]
            })

            tile.deviceGroups = working
        }

        newTiles.forEach(consolidateDeviceGroupsInTile)
        devicesAddedCount = newTiles.reduce((sum, t) => sum + t.deviceGroups.length, 0)

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

    // Merge helper: preserves user's manual-group entries when auto-refreshing HA tiles
    const mergeWithManualGroups = (freshTiles: DashboardTile[], previousTiles: DashboardTile[]): DashboardTile[] => {
        const manualByRoom = new Map<string, DeviceGroup>()
        previousTiles.forEach(t => {
            const manual = (t.deviceGroups || []).find(g => g.id === 'manual-group')
            if (manual && manual.entities.length > 0) {
                manualByRoom.set((t.roomId || t.id).toLowerCase(), manual)
            }
        })
        if (manualByRoom.size === 0) return freshTiles
        return freshTiles.map(t => {
            const manual = manualByRoom.get((t.roomId || t.id).toLowerCase())
            if (!manual) return t
            return { ...t, deviceGroups: [...t.deviceGroups, manual] }
        })
    }

    // Automatic smart sync & self-healing:
    // 1. Waits cleanly for HA Device/Entity Registries (WS or Wi-Fi REST /api/template) so REST states never create flat 1-entity soup.
    // 2. Automatically self-heals any previously ungrouped/fragmented caches (`live-*`, `grp-*`, `cluster-*`, duplicate names like 2x `Patje`).
    useEffect(() => {
        if (!activeConnection?.id) return
        if (loadedConnectionIdRef.current !== activeConnection.id) return

        const hasRegistryData = (haEntitiesRegistry?.length || 0) > 0
        const stateCount = Object.keys(entityStates || {}).length
        if (!hasRegistryData && stateCount === 0) return

        const sig = `${activeConnection.id}:v34:reg=${haEntitiesRegistry?.length || 0}:dev=${haDevices?.length || 0}:area=${haAreas?.length || 0}:st=${stateCount}`
        if (lastSyncedSigRef.current === sig) return

        const interactiveTypes = new Set([
            'light', 'switch', 'input_boolean', 'select', 'input_select', 'button', 'input_button',
            'number', 'input_number', 'climate', 'water_heater', 'cover', 'lock', 'valve', 'fan',
            'humidifier', 'vacuum', 'lawn_mower', 'media', 'siren', 'remote', 'scene', 'script'
        ])

        const existingEntityIds = new Set<string>()
        let hasAnyPlatformMeta = false
        let hasMisclassifiedInteractiveDiag = false
        let hasUngroupedFallbackGroups = false
        let hasRepeatedPrefixFragmentation = false
        let totalDevicesInTiles = 0
        tiles.forEach(t => {
            if (t.roomIcon === 'not_found') hasUngroupedFallbackGroups = true
            const firstWordCounts = new Map<string, number>()
            const exactNameCounts = new Map<string, number>()
            ;(t.deviceGroups || []).forEach(g => {
                totalDevicesInTiles++
                if (g.platform) hasAnyPlatformMeta = true
                if (g.id.startsWith('live-') || g.id.startsWith('grp-') || g.id.startsWith('legacy-')) {
                    hasUngroupedFallbackGroups = true
                }
                const normName = (g.name || '').trim().toLowerCase()
                if (normName.length >= 3) {
                    const ec = (exactNameCounts.get(normName) || 0) + 1
                    exactNameCounts.set(normName, ec)
                    if (ec >= 2) hasRepeatedPrefixFragmentation = true
                }
                const isLoose = g.entities.length === 1 || g.id.startsWith('cluster-') || g.id.startsWith('orp-')
                if (isLoose) {
                    const fw = normName.split(/\s+/)[0] || ''
                    if (fw.length >= 3) {
                        const c = (firstWordCounts.get(fw) || 0) + 1
                        firstWordCounts.set(fw, c)
                        if (c >= 2 && (g.id.startsWith('cluster-') || c >= 3)) hasRepeatedPrefixFragmentation = true
                    }
                }
                ;(g.entities || []).forEach(e => {
                    if (e.entityId) existingEntityIds.add(e.entityId)
                    if (e.isDiagnostic) {
                        const eidLower = (e.entityId || '').toLowerCase()
                        if (interactiveTypes.has(e.type) && !eidLower.includes('_identify') && !eidLower.includes('_reboot') && !eidLower.includes('_restart')) {
                            hasMisclassifiedInteractiveDiag = true
                        }
                        if (/(?:^|_)(toner|ink|inkt|cartridge|drum|salt|rinse_aid|filter_life)(?:_|$)/.test(eidLower)) {
                            hasMisclassifiedInteractiveDiag = true
                        }
                    }
                })
            })
        })

        // If registries haven't arrived yet:
        // - If we already have tiles cached and not fragmented, keep them untouched until registries arrive!
        // - If we have 0 devices, give WS / REST rich topology a 3.5s grace window before falling back to consolidated PATH B!
        if (!hasRegistryData) {
            if (totalDevicesInTiles > 0 && !hasRepeatedPrefixFragmentation) return
            const fallbackTimer = setTimeout(() => {
                const { newTiles, devicesAddedCount } = buildTilesFromHA([], [], [], entityStates)
                if (devicesAddedCount > 0) {
                    setTiles(prev => mergeWithManualGroups(newTiles, prev))
                    logger.info(`ℹ️ [Dashboard] Built consolidated REST fallback layout (${newTiles.length} rooms, ${devicesAddedCount} devices)`)
                }
            }, totalDevicesInTiles > 0 ? 400 : 3500)
            return () => clearTimeout(fallbackTimer)
        }

        const hasNewRegistryEntities = haEntitiesRegistry.some(
            e => e?.entity_id && !e.hidden_by && !e.disabled_by && !existingEntityIds.has(e.entity_id)
        )
        const registryDeviceCount = (haDevices || []).length
        const looksOverFragmented = registryDeviceCount > 0 && totalDevicesInTiles > registryDeviceCount * 2 + 15
        const needsPlatformUpgrade = totalDevicesInTiles > 0 && !hasAnyPlatformMeta && haDevices.some((d: any) => !!d?.platform)

        if (
            totalDevicesInTiles === 0 ||
            hasUngroupedFallbackGroups ||
            hasRepeatedPrefixFragmentation ||
            looksOverFragmented ||
            hasNewRegistryEntities ||
            needsPlatformUpgrade ||
            hasMisclassifiedInteractiveDiag
        ) {
            const { newTiles, devicesAddedCount } = buildTilesFromHA(haAreas, haDevices, haEntitiesRegistry, entityStates)
            if (devicesAddedCount > 0) {
                lastSyncedSigRef.current = sig
                setTiles(prev => mergeWithManualGroups(newTiles, prev))
                logger.info(`✅ [Dashboard] Auto-synced & consolidated ${newTiles.length} rooms & ${devicesAddedCount} devices from Home Assistant`)
            }
        } else {
            lastSyncedSigRef.current = sig
        }
    }, [activeConnection?.id, haAreas, haDevices, haEntitiesRegistry, entityStates, tiles.length])

    // Manual HA Live Refresh & Layout Sync (ALWAYS fetches fresh live states + registries from HA!)
    const importLayoutFromHA = async () => {
        if (isSyncingLayout) return
        setIsSyncingLayout(true)
        setToastMsg('🔄 Live synchroniseren met Home Assistant...')
        try {
            const fresh = await refreshHAFromServer()
            const statesToUse = fresh.states || entityStates || {}
            const areasToUse = fresh.areas || haAreas || []
            const devicesToUse = fresh.devices || haDevices || []
            const entitiesRegToUse = fresh.entities || haEntitiesRegistry || []

            const { newTiles, areasCreatedCount, devicesAddedCount } = buildTilesFromHA(
                areasToUse,
                devicesToUse,
                entitiesRegToUse,
                statesToUse
            )

            if (newTiles.length > 0 || devicesAddedCount > 0) {
                lastSyncedSigRef.current = `${activeConnection?.id || ''}:v34:reg=${entitiesRegToUse.length}:dev=${devicesToUse.length}:area=${areasToUse.length}:st=${Object.keys(statesToUse).length}`
                setTiles(prev => mergeWithManualGroups(newTiles, prev))

                if (fresh.error) {
                    setToastMsg(`⚠️ Home Assistant niet bereikbaar (${fresh.error}) — opgeslagen gegevens gegroepeerd.`)
                    setTimeout(() => setToastMsg(null), 5000)
                } else {
                    const modeLabel = fresh.source === 'websocket' ? 'WS' : 'REST'
                    setToastMsg(`✅ Live vernieuwd (${modeLabel}): ${devicesAddedCount} apparaten in ${areasCreatedCount} kamers!`)
                    setTimeout(() => setToastMsg(null), 3500)
                }
            } else {
                setToastMsg(`❌ ${fresh.error || 'Geen apparaten gevonden in Home Assistant. Controleer je URL/Wi-Fi.'}`)
                setTimeout(() => setToastMsg(null), 5000)
            }
        } catch (err: any) {
            setToastMsg(`❌ Sync fout: ${err?.message || 'Kon niet verbinden met Home Assistant'}`)
            setTimeout(() => setToastMsg(null), 5000)
        } finally {
            setIsSyncingLayout(false)
        }
    }



    const openRoomConfig = (tileId: string) => {
        setConfigTileId(tileId)
        setEditingDevice(null)
        setShowDevicePicker(false)
    }

    // --- UI Helpers ---

    const getDevicePriority = (type: string) => {
        // High priority: Controls that do things
        if (['light', 'switch', 'lock', 'cover', 'climate', 'water_heater', 'media', 'vacuum', 'lawn_mower', 'fan', 'humidifier', 'input_boolean', 'automation', 'select', 'button'].includes(type)) return 0
        // Medium: Binary Sensors (often security/occupancy)
        if (type === 'binary_sensor') return 1
        // Low: Read-only sensors
        return 2
    }

    const resolveGroupIcon = (group: DeviceGroup, fallbackIcon?: string) => {
        const primary = group.primaryEntity || group.entities[0]
        const name = (group.entities.length > 1 && group.name && group.name !== 'Unknown Device')
            ? group.name
            : (primary?.name || group.name || '')
        const baseFallback = fallbackIcon || primary?.icon || '📦'
        if (group.entities.some(e => e.type === 'vacuum')) {
            return getApplianceIcon(name, '🤖')
        }
        return getApplianceIcon(name, baseFallback)
    }

    // Level 1: Home Room Card (1 clean summary row per physical device)
    const renderRoomCard = (tile: DashboardTile) => {
        let temp: { config: RoomDevice, ha: any } | undefined;
        let hum: { config: RoomDevice, ha: any } | undefined;

        if (tile.id !== 'unassigned') {
            const allEntities = tile.deviceGroups.flatMap(g => g.entities).map(d => ({ config: d, ha: entityStates[d.entityId || ''] }))

            const isValidEnv = (d: any) => {
                const id = d.config.entityId?.toLowerCase() || '';
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

        const validGroups = [...tile.deviceGroups].filter(g => Boolean(g.primaryEntity || g.entities[0]))
        const nonDiagOnlyGroups = validGroups.filter(g => !g.entities.every(e => e.isDiagnostic))
        const displayableGroups = nonDiagOnlyGroups.length > 0 ? nonDiagOnlyGroups : validGroups

        const sortedVisibleGroups = displayableGroups.sort((a, b) => {
            const typeA = a.primaryEntity?.type || 'sensor'
            const typeB = b.primaryEntity?.type || 'sensor'
            const priA = getDevicePriority(typeA)
            const priB = getDevicePriority(typeB)
            if (priA !== priB) return priA - priB
            // Multi-entity appliances (washer, dryer, dishwasher, vacuum, printer, etc.) appear before lone sensors
            const multiA = a.entities.length > 1 ? 0 : 1
            const multiB = b.entities.length > 1 ? 0 : 1
            if (multiA !== multiB) return multiA - multiB
            return a.name.localeCompare(b.name)
        })

        const MAX_PREVIEW_ROWS = 5
        const previewGroups = sortedVisibleGroups.slice(0, MAX_PREVIEW_ROWS)
        const hiddenOverflowCount = Math.max(0, sortedVisibleGroups.length - MAX_PREVIEW_ROWS)

        return (
            <div key={tile.id} className="room-card" onClick={() => setDetailTileId(tile.id)}>
                {editMode && (
                    <button className="tile-delete-btn" onClick={(e) => { e.stopPropagation(); handleDeleteRoom(tile.id) }}>✕</button>
                )}

                <div className="room-header">
                    <div className="room-title" style={{ minWidth: 0 }}>
                        <span style={{ fontSize: '1.4rem', flexShrink: 0 }}>
                            {(tile.id.includes('weather') && entityStates['sun.sun']) ?
                                (entityStates['sun.sun'].state === 'below_horizon' ? '🌙' : '☀️')
                                : resolveRoomIcon(tile.roomName, tile.roomIcon)
                            }
                        </span>
                        <span style={{ fontSize: '1.12rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tile.roomName}
                        </span>
                    </div>

                    <div className="room-sensors">
                        {(tempVal || humVal) && (
                            <span className="sensor-badge">
                                {tempVal && <span>{tempVal}{tempUnit}</span>}
                                {tempVal && humVal && <span>•</span>}
                                {humVal && <span>{humVal}{humUnit}</span>}
                            </span>
                        )}
                        {tile.id !== 'unassigned' && sortedVisibleGroups.length > 0 && (
                            <span className="sensor-badge" style={{ opacity: 0.85 }}>
                                {sortedVisibleGroups.length}
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
                    <div className="room-entity-list" style={{ marginTop: 4 }}>
                        {previewGroups.length === 0 && (
                            <div style={{ opacity: 0.5, fontSize: '0.8rem', padding: '10px 0' }}>Geen apparaten in deze kamer.</div>
                        )}
                        {previewGroups.map(group => {
                            const primary = group.primaryEntity || group.entities[0]
                            if (!primary) return null

                            const ha = entityStates[primary.entityId || '']
                            const config = primary
                            const summary = getDeviceGroupSummary(group)

                            const isSimpleToggleable =
                                group.entities.length === 1 &&
                                ['light', 'switch', 'input_boolean', 'lock', 'media', 'cover', 'fan', 'vacuum', 'humidifier'].includes(config.type)
                            const isWarm = (config.type === 'sensor' || config.type === 'climate') && (ha?.attributes?.device_class === 'temperature')

                            const displayName = (group.entities.length > 1 && group.name && group.name !== 'Unknown Device')
                                ? group.name
                                : (config.name || group.name)

                            return (
                                <div
                                    key={group.id}
                                    className="entity-row"
                                    style={{ cursor: 'pointer' }}
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setDetailTileId(tile.id)
                                        openDeviceSheet(tile.id, tile.roomName || 'Kamer', group)
                                    }}
                                >
                                    <div className="entity-main">
                                        <div className={`entity-icon ${summary.isActive ? 'active' : ''} ${isWarm ? 'warm' : ''}`}>
                                            {resolveGroupIcon(group, config.icon)}
                                        </div>
                                        <div className="entity-name">{displayName}</div>
                                    </div>

                                    {isSimpleToggleable ? (
                                        <div className={`toggle-switch compact ${summary.isActive ? 'on' : ''}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleToggle(config.entityId!, ha?.state || 'off')
                                            }}>
                                        </div>
                                    ) : (
                                        <div className="entity-state">{summary.statusText} ›</div>
                                    )}
                                </div>
                            )
                        })}
                        {hiddenOverflowCount > 0 && (
                            <div className="room-more-pill">
                                +{hiddenOverflowCount} meer {hiddenOverflowCount === 1 ? 'apparaat' : 'apparaten'} bekijken ›
                            </div>
                        )}
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

    // Helper: compute a clean, human-readable summary string for a DeviceGroup
    const getDeviceGroupSummary = (group: DeviceGroup): { statusText: string; isActive: boolean; controlCount: number; nonDiagCount: number } => {
        const nonDiag = group.entities.filter(e => !e.isDiagnostic)
        const primary = group.primaryEntity || nonDiag[0] || group.entities[0]
        const primaryHa = primary?.entityId ? entityStates[primary.entityId] : undefined

        const controlDomains = new Set([
            'light', 'switch', 'input_boolean', 'select', 'input_select', 'button', 'input_button',
            'number', 'input_number', 'climate', 'water_heater', 'cover', 'lock', 'valve', 'fan',
            'humidifier', 'vacuum', 'lawn_mower', 'media', 'siren', 'remote', 'scene', 'script'
        ])
        const controlCount = nonDiag.filter(e => controlDomains.has(e.type)).length

        const isActiveState = (st?: string) => {
            const s = (st || '').toLowerCase()
            return s === 'on' || s === 'playing' || s === 'open' || s === 'running' || s === 'cleaning' || s === 'mowing' || s === 'active' || s === 'heating' || s === 'cooling' || s === 'auto'
        }

        const isActive = nonDiag.some(e => {
            const ha = e.entityId ? entityStates[e.entityId] : undefined
            return ha && controlDomains.has(e.type) && isActiveState(ha.state)
        }) || (primaryHa ? isActiveState(primaryHa.state) : false)

        if (!primary || !primaryHa) {
            return { statusText: 'Onbekend', isActive: false, controlCount, nonDiagCount: nonDiag.length }
        }

        if (primary.type === 'light') {
            const bri = primaryHa.attributes?.brightness ? Math.round((primaryHa.attributes.brightness / 255) * 100) : 0
            return {
                statusText: isActiveState(primaryHa.state) ? (bri > 0 ? `Aan • ${bri}%` : 'Aan') : 'Uit',
                isActive: isActiveState(primaryHa.state),
                controlCount,
                nonDiagCount: nonDiag.length
            }
        }
        if (primary.type === 'climate' || primary.type === 'water_heater') {
            const cur = primaryHa.attributes?.current_temperature
            const tgt = primaryHa.attributes?.temperature
            const mode = formatHAStateLabel(primaryHa.state)
            const parts = [mode]
            if (cur !== undefined) parts.push(`${cur}°`)
            if (tgt !== undefined) parts.push(`→ ${tgt}°`)
            return { statusText: parts.join(' • '), isActive: primaryHa.state !== 'off', controlCount, nonDiagCount: nonDiag.length }
        }
        if (primary.type === 'cover') {
            const pos = primaryHa.attributes?.current_position
            const txt = primaryHa.state === 'open' && pos !== undefined
                ? `Open (${pos}%)`
                : formatHAStateLabel(primaryHa.state, primaryHa.attributes, primary.entityId)
            return { statusText: txt, isActive: primaryHa.state === 'open', controlCount, nonDiagCount: nonDiag.length }
        }
        if (primary.type === 'media') {
            const title = primaryHa.attributes?.media_title
            const mode = formatHAStateLabel(primaryHa.state)
            return { statusText: title ? `${mode} • ${title}` : mode, isActive: primaryHa.state === 'playing', controlCount, nonDiagCount: nonDiag.length }
        }

        // For multi-entity appliances (washer, dryer, dishwasher, etc.): combine primary status + remaining time if active!
        const primaryText = formatHAStateLabel(primaryHa.state, primaryHa.attributes, primary.entityId)
        if (nonDiag.length > 1) {
            const remSensor = nonDiag.find(e =>
                e.entityId &&
                e.entityId !== primary.entityId &&
                /remaining|resterend|time_left|completion|progress/.test(e.entityId.toLowerCase())
            )
            const remHa = remSensor?.entityId ? entityStates[remSensor.entityId] : undefined
            if (remHa && remHa.state && !['unknown', 'unavailable', '0', '00:00', '0:00:00', 'none', 'idle'].includes(String(remHa.state).toLowerCase())) {
                const remFormatted = formatHAStateLabel(remHa.state, remHa.attributes, remSensor?.entityId)
                return { statusText: `${primaryText} • ${remFormatted}`, isActive, controlCount, nonDiagCount: nonDiag.length }
            }
        }

        return { statusText: primaryText, isActive, controlCount, nonDiagCount: nonDiag.length }
    }

    const openDeviceSheet = (tileId: string | null, roomName: string, group: DeviceGroup) => {
        setShowDiagnostics(false)
        setSelectedDevice({
            tileId,
            roomName,
            groupId: group.id,
            fallbackGroup: group
        })
    }

    // LEVEL 2: Room Detail View — 1 clean, tappable Device Card per Device (NO flat entity soup!)
    const renderDetailView = () => {
        const tile = tiles.find(t => t.id === detailTileId)
        if (!tile) return null

        const visibleGroups = tile.deviceGroups.filter(g => g.entities && g.entities.length > 0)

        const controlGroupTypes = new Set([
            'light', 'switch', 'input_boolean', 'climate', 'water_heater', 'cover', 'lock', 'valve',
            'media', 'fan', 'vacuum', 'lawn_mower', 'humidifier', 'select', 'input_select', 'button',
            'input_button', 'number', 'input_number', 'siren', 'remote', 'scene', 'script', 'alarm_control_panel'
        ])

        const applianceAndControlGroups: DeviceGroup[] = []
        const sensorOnlyGroups: DeviceGroup[] = []

        visibleGroups.forEach(group => {
            const hasControl = group.entities.some(e => !e.isDiagnostic && controlGroupTypes.has(e.type))
            if (hasControl || group.entities.length > 1) {
                applianceAndControlGroups.push(group)
            } else {
                sensorOnlyGroups.push(group)
            }
        })

        const renderDeviceTileCard = (group: DeviceGroup) => {
            const primary = group.primaryEntity || group.entities[0]
            if (!primary) return null
            const ha = primary.entityId ? entityStates[primary.entityId] : undefined
            const summary = getDeviceGroupSummary(group)
            const icon = resolveGroupIcon(group, primary.icon)

            const isSimpleToggle =
                group.entities.length === 1 &&
                ['light', 'switch', 'input_boolean', 'fan', 'humidifier', 'lock', 'valve', 'siren', 'remote'].includes(primary.type) &&
                !!primary.entityId

            const extraCount = summary.nonDiagCount

            return (
                <div
                    key={group.id}
                    className={`device-tile-card ${summary.isActive ? 'is-active' : ''}`}
                    onClick={() => openDeviceSheet(tile.id, tile.roomName || 'Kamer', group)}
                >
                    <div className="device-tile-icon">{icon}</div>
                    <div className="device-tile-meta">
                        <div className="device-tile-title">{group.name}</div>
                        <div className="device-tile-sub">
                            <span>{summary.statusText}</span>
                            {group.platform && (
                                <span className="integration-pill">{group.platform}</span>
                            )}
                        </div>
                    </div>
                    <div className="device-tile-right">
                        {isSimpleToggle ? (
                            <div
                                className={`toggle-switch compact ${summary.isActive ? 'on' : ''}`}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    handleToggle(primary.entityId!, ha?.state || 'off')
                                }}
                            />
                        ) : extraCount > 1 ? (
                            <span className="device-options-pill">
                                {summary.controlCount > 0 ? `🎛️ ${summary.controlCount}` : `📊 ${extraCount}`} ›
                            </span>
                        ) : (
                            <span style={{ opacity: 0.45, fontSize: '1.1rem', fontWeight: 600 }}>›</span>
                        )}
                    </div>
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
                width: '100%',
                overflow: 'hidden'
            }}>
                {/* Header */}
                <div className="detail-header" style={{ display: 'flex', alignItems: 'center', marginBottom: '16px', gap: '12px', flexShrink: 0 }}>
                    <button
                        className="device-back-btn"
                        onClick={() => setDetailTileId(null)}
                    >
                        ⬅ Kamers
                    </button>
                    <h2 style={{ margin: 0, fontSize: '1.15rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tile.roomIcon} {tile.roomName}
                    </h2>
                    <button className="configure-btn" onClick={() => { setDetailTileId(null); openRoomConfig(tile.id) }} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                        ⚙️
                    </button>
                </div>

                <div className="device-list-scroller" style={{ padding: '0 2px 16px' }}>
                    {applianceAndControlGroups.length > 0 && (
                        <div className="detail-section">
                            <div className="control-section-header">
                                <span>⚡</span> Apparaten & Bediening ({applianceAndControlGroups.length})
                            </div>
                            <div className="device-group-grid">
                                {applianceAndControlGroups.map(renderDeviceTileCard)}
                            </div>
                        </div>
                    )}

                    {sensorOnlyGroups.length > 0 && (
                        <div className="detail-section">
                            <div className="control-section-header">
                                <span>📊</span> Losse Sensoren ({sensorOnlyGroups.length})
                            </div>
                            <div className="device-group-grid">
                                {sensorOnlyGroups.map(renderDeviceTileCard)}
                            </div>
                        </div>
                    )}

                    {visibleGroups.length === 0 && (
                        <div style={{ textAlign: 'center', opacity: 0.55, marginTop: 40 }}>
                            Geen apparaten gevonden in deze kamer.
                        </div>
                    )}
                </div>
            </div>
        )
    }

    // LEVEL 3: SOTA Interactive Device Control Sheet (switches, pill selectors, action buttons, steppers, sensors & collapsible diagnostics)
    const renderDeviceControlSheet = () => {
        if (!selectedDevice) return null

        // Resolve latest group from tiles (so live auto-sync updates reflect immediately) or fallbackGroup
        const parentTile = selectedDevice.tileId ? tiles.find(t => t.id === selectedDevice.tileId) : undefined
        const group = parentTile?.deviceGroups.find(g => g.id === selectedDevice.groupId) || selectedDevice.fallbackGroup
        if (!group) return null

        const summary = getDeviceGroupSummary(group)
        const primary = group.primaryEntity || group.entities[0]
        const heroIcon = resolveGroupIcon(group, primary?.icon || '📦')

        const nonDiag = group.entities.filter(e => !e.isDiagnostic)
        const diagEntities = group.entities.filter(e => e.isDiagnostic)

        const switchAndMainTypes = new Set([
            'light', 'switch', 'input_boolean', 'climate', 'water_heater', 'cover', 'lock', 'valve',
            'fan', 'humidifier', 'vacuum', 'lawn_mower', 'media', 'siren', 'remote', 'alarm_control_panel'
        ])
        const selectTypes = new Set(['select', 'input_select'])
        const buttonTypes = new Set(['button', 'input_button', 'scene', 'script', 'automation'])
        const numberTypes = new Set(['number', 'input_number'])

        const mainControls = nonDiag.filter(e => switchAndMainTypes.has(e.type))
        const allSelectControls = nonDiag.filter(e => selectTypes.has(e.type))
        const isProgramSelect = (e: RoomDevice) => {
            const hay = `${e.entityId || ''} ${e.name || ''}`.toLowerCase()
            return /cycle|course|program|programma|wasprogramma|droogprogramma|selected_program|active_program|wash_mode|dry_mode|operation_mode|\bmode\b|\bmodus\b/.test(hay) &&
                !/rinse|spin|temp|soil|dry_level|droogniveau|water|detergent|softener|delay|uitstel|reminder|sound|volume|tone/.test(hay)
        }
        const programSelectControls = allSelectControls.filter(isProgramSelect)
        const parameterSelectControls = allSelectControls.filter(e => !isProgramSelect(e))
        const actionControls = nonDiag.filter(e => buttonTypes.has(e.type))
        const numberControls = nonDiag.filter(e => numberTypes.has(e.type))
        const sensorEntities = nonDiag.filter(e =>
            !switchAndMainTypes.has(e.type) &&
            !selectTypes.has(e.type) &&
            !buttonTypes.has(e.type) &&
            !numberTypes.has(e.type)
        )

        // Check if Home Assistant has any disabled entities on this device (e.g. disabled_by="integration")
        const disabledDeviceEntities = (haEntitiesRegistry || []).filter(
            (e: any) => e?.device_id && e.device_id === group.id && e.disabled_by
        )
        const disabledProgramEntity = disabledDeviceEntities.find((e: any) =>
            /cycle|course|program|programma|mode/.test(`${e.entity_id || ''} ${e.name || ''} ${e.original_name || ''}`.toLowerCase())
        )
        const isLikelyAppliance = /wasmachine|washer|washing|droogkast|droger|dryer|tumble|vaatwasser|dishwasher|oven|localthings|smartthings|home_connect|miele|thinq/i.test(
            `${group.name} ${group.platform || ''} ${group.manufacturer || ''} ${group.model || ''}`
        )
        const hasAnyControls = mainControls.length + allSelectControls.length + actionControls.length + numberControls.length > 0
        const showMissingProgramHint = isLikelyAppliance && hasAnyControls && programSelectControls.length === 0

        const renderSelectCard = (ent: RoomDevice, isProgramHero = false) => {
            const ha = ent.entityId ? entityStates[ent.entityId] : undefined
            if (!ent.entityId || !ha) return null
            const label = getCleanSubEntityName(ent.name, group.name)
            const options: string[] = Array.isArray(ha.attributes?.options) ? ha.attributes.options : []
            const currentVal = ha.state
            const isUnavailable = currentVal === 'unavailable'
            const isUnknown = currentVal === 'unknown' || currentVal === 'none' || !currentVal

            return (
                <div
                    key={ent.id}
                    className="control-block"
                    style={isProgramHero ? {
                        borderColor: 'rgba(99, 102, 241, 0.38)',
                        background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(15, 23, 42, 0.45))'
                    } : undefined}
                >
                    <div className="control-block-row">
                        <div className="control-block-label">
                            <span>{isProgramHero ? '🧺' : '🎛️'}</span>
                            <span>{label}</span>
                        </div>
                        <span className="control-block-value">
                            {formatHAStateLabel(currentVal)}
                            {options.length > 0 ? ` (${options.length})` : ''}
                        </span>
                    </div>

                    {isUnavailable && (
                        <div style={{ fontSize: '0.75rem', color: '#fbbf24', opacity: 0.9 }}>
                            ⚠️ Apparaat staat uit of is niet bereikbaar — zet het toestel (en Smart Control) aan om te kiezen.
                        </div>
                    )}

                    {options.length > 0 ? (
                        <div
                            className="control-pill-grid"
                            style={options.length > 14 ? { maxHeight: '220px', overflowY: 'auto', paddingRight: '4px' } : undefined}
                        >
                            {options.map(opt => (
                                <button
                                    key={opt}
                                    type="button"
                                    className={`control-pill-btn ${!isUnknown && !isUnavailable && currentVal === opt ? 'active' : ''}`}
                                    onClick={() => handleSelectOption(ent.entityId!, opt)}
                                >
                                    {formatHAStateLabel(opt)}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div style={{ fontSize: '0.78rem', opacity: 0.65 }}>
                            {isUnavailable || isUnknown
                                ? 'Opties worden door Home Assistant geladen zodra het apparaat aan staat.'
                                : 'Geen opties gerapporteerd door Home Assistant.'}
                        </div>
                    )}
                </div>
            )
        }

        const getActionIcon = (label: string, type: string) => {
            const l = label.toLowerCase()
            if (l.includes('start') || l.includes('play') || l.includes('begin')) return '▶'
            if (l.includes('pauze') || l.includes('pause')) return '⏸'
            if (l.includes('stop') || l.includes('cancel') || l.includes('annuleer')) return '⏹'
            if (l.includes('reset') || l.includes('sync') || l.includes('vernieuw')) return '🔄'
            if (type === 'scene') return '✨'
            return '⚡'
        }

        return (
            <div className="device-sheet">
                {/* Top Navigation Bar */}
                <div className="device-sheet-topbar">
                    <button
                        className="device-back-btn"
                        onClick={() => setSelectedDevice(null)}
                    >
                        ⬅ {selectedDevice.roomName}
                    </button>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                        {group.entities.length} {group.entities.length === 1 ? 'entiteit' : 'entiteiten'}
                    </span>
                </div>

                {/* Device Hero Banner */}
                <div className="device-sheet-hero">
                    <div className="device-hero-icon">{heroIcon}</div>
                    <div className="device-hero-info">
                        <div className="device-hero-name">{group.name}</div>
                        <div className="device-hero-meta">
                            {(group.manufacturer || group.model) && (
                                <span>{[group.manufacturer, group.model].filter(Boolean).join(' • ')}</span>
                            )}
                            {group.platform && (
                                <span className="integration-pill">{group.platform}</span>
                            )}
                        </div>
                    </div>
                    <div className={`device-hero-status ${summary.isActive ? 'active' : ''}`}>
                        {summary.statusText}
                    </div>
                </div>

                {/* Scrollable Control Sections */}
                <div className="device-sheet-scroller">

                    {/* 0. Dedicated Machine Program / Cycle Selector at the VERY TOP */}
                    {programSelectControls.length > 0 && (
                        <div>
                            <div className="control-section-header">🧺 Programma / Cyclus kiezen</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {programSelectControls.map(ent => renderSelectCard(ent, true))}
                            </div>
                        </div>
                    )}

                    {/* Helpful diagnostic hint if an appliance has parameters in HA but NO program select entity */}
                    {showMissingProgramHint && (
                        <div style={{
                            padding: '11px 13px',
                            borderRadius: '14px',
                            background: 'rgba(245, 158, 11, 0.1)',
                            border: '1px solid rgba(245, 158, 11, 0.3)',
                            fontSize: '0.78rem',
                            lineHeight: 1.45,
                            color: '#fde68a'
                        }}>
                            {disabledProgramEntity ? (
                                <>
                                    <strong>⚠️ Programmakeuze staat uitgeschakeld in Home Assistant:</strong>{' '}
                                    <code>{disabledProgramEntity.entity_id}</code>. Schakel deze entiteit in via Home Assistant → Instellingen → Apparaten → {group.name}.
                                </>
                            ) : (
                                <>
                                    <strong>ℹ️ Geen programmakeuze ontvangen van Home Assistant:</strong>{' '}
                                    De integratie{group.platform ? ` (${group.platform})` : ''} levert voor dit model momenteel alleen losse parameters en geen <code>select.*_cycle</code>/<code>program</code> entiteit. Controleer in Home Assistant → Apparaten → {group.name} of de integratie geüpdatet moet worden of dat Smart Control actief is op het toestel.
                                </>
                            )}
                        </div>
                    )}

                    {/* 1. Primary Switches, Lights, Climate, Covers, Media */}
                    {mainControls.length > 0 && (
                        <div>
                            <div className="control-section-header">⚡ Schakelaars & Bediening</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {mainControls.map(ent => {
                                    const ha = ent.entityId ? entityStates[ent.entityId] : undefined
                                    if (!ent.entityId || !ha) return null
                                    const label = getCleanSubEntityName(ent.name, group.name)
                                    const isOn = ['on', 'playing', 'open', 'unlocked', 'cleaning', 'mowing', 'active'].includes((ha.state || '').toLowerCase())
                                    const brightness = ha.attributes?.brightness ? Math.round((ha.attributes.brightness / 255) * 100) : 0

                                    // Climate / Water Heater
                                    if (ent.type === 'climate' || ent.type === 'water_heater') {
                                        const targetTemp = typeof ha.attributes?.temperature === 'number' ? ha.attributes.temperature : 20
                                        const curTemp = ha.attributes?.current_temperature
                                        const hvacModes: string[] = Array.isArray(ha.attributes?.hvac_modes) ? ha.attributes.hvac_modes : []
                                        return (
                                            <div key={ent.id} className="control-block">
                                                <div className="control-block-row">
                                                    <div className="control-block-label">
                                                        <span>{ent.icon}</span>
                                                        <div>
                                                            <div>{label}</div>
                                                            {curTemp !== undefined && (
                                                                <div className="control-block-value">Nu {curTemp}°C • {formatHAStateLabel(ha.state)}</div>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="control-stepper">
                                                        <button type="button" className="stepper-btn" onClick={() => handleClimateTemp(ent.entityId!, Math.round((targetTemp - 0.5) * 2) / 2)}>−</button>
                                                        <span className="stepper-val">{targetTemp}°C</span>
                                                        <button type="button" className="stepper-btn" onClick={() => handleClimateTemp(ent.entityId!, Math.round((targetTemp + 0.5) * 2) / 2)}>+</button>
                                                    </div>
                                                </div>
                                                {hvacModes.length > 0 && ent.type === 'climate' && (
                                                    <div className="control-pill-grid">
                                                        {hvacModes.map(mode => (
                                                            <button
                                                                key={mode}
                                                                type="button"
                                                                className={`control-pill-btn ${ha.state === mode ? 'active' : ''}`}
                                                                onClick={() => handleClimateMode(ent.entityId!, mode)}
                                                            >
                                                                {formatHAStateLabel(mode)}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    }

                                    // Cover
                                    if (ent.type === 'cover') {
                                        const pos = ha.attributes?.current_position
                                        return (
                                            <div key={ent.id} className="control-block">
                                                <div className="control-block-row">
                                                    <div className="control-block-label"><span>{ent.icon}</span> {label}</div>
                                                    <span className="control-block-value">
                                                        {formatHAStateLabel(ha.state)}{pos !== undefined ? ` • ${pos}%` : ''}
                                                    </span>
                                                </div>
                                                <div className="control-pill-grid">
                                                    <button type="button" className={`control-pill-btn ${ha.state === 'open' ? 'active' : ''}`} style={{ flex: 1 }} onClick={() => handleCoverAction(ent.entityId!, 'open')}>⬆ Open</button>
                                                    <button type="button" className="control-pill-btn" style={{ flex: 1 }} onClick={() => handleCoverAction(ent.entityId!, 'stop')}>⏹ Stop</button>
                                                    <button type="button" className={`control-pill-btn ${ha.state === 'closed' ? 'active' : ''}`} style={{ flex: 1 }} onClick={() => handleCoverAction(ent.entityId!, 'close')}>⬇ Dicht</button>
                                                </div>
                                            </div>
                                        )
                                    }

                                    // Media Player
                                    if (ent.type === 'media') {
                                        const title = ha.attributes?.media_title
                                        return (
                                            <div key={ent.id} className="control-block">
                                                <div className="control-block-row">
                                                    <div className="control-block-label">
                                                        <span>{ent.icon}</span>
                                                        <div>
                                                            <div>{label}</div>
                                                            <div className="control-block-value">{title || formatHAStateLabel(ha.state)}</div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="control-pill-grid">
                                                    <button type="button" className="control-pill-btn" style={{ flex: 1 }} onClick={() => handleMediaAction(ent.entityId!, 'media_previous_track')}>⏮</button>
                                                    <button type="button" className={`control-pill-btn ${isOn ? 'active' : ''}`} style={{ flex: 1.4 }} onClick={() => handleMediaAction(ent.entityId!, 'media_play_pause')}>{isOn ? '⏸ Pauze' : '▶ Afspelen'}</button>
                                                    <button type="button" className="control-pill-btn" style={{ flex: 1 }} onClick={() => handleMediaAction(ent.entityId!, 'media_next_track')}>⏭</button>
                                                    <button type="button" className="control-pill-btn" onClick={() => handleMediaAction(ent.entityId!, 'volume_down')}>🔉</button>
                                                    <button type="button" className="control-pill-btn" onClick={() => handleMediaAction(ent.entityId!, 'volume_up')}>🔊</button>
                                                </div>
                                            </div>
                                        )
                                    }

                                    // Robot Vacuum (Patje, Roomba, Roborock, Deebot, etc.)
                                    if (ent.type === 'vacuum') {
                                        const vacState = String(ha.state || '').toLowerCase()
                                        const battery = ha.attributes?.battery_level
                                        const fanSpeeds: string[] = Array.isArray(ha.attributes?.fan_speed_list) ? ha.attributes.fan_speed_list : []
                                        const curFanSpeed = ha.attributes?.fan_speed
                                        return (
                                            <div key={ent.id} className="control-block">
                                                <div className="control-block-row">
                                                    <div className="control-block-label">
                                                        <span>🤖</span>
                                                        <div>
                                                            <div>{label}</div>
                                                            <div className="control-block-value">
                                                                {formatHAStateLabel(ha.state, ha.attributes, ent.entityId)}
                                                                {battery !== undefined ? ` • 🔋 ${battery}%` : ''}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="control-pill-grid">
                                                    <button
                                                        type="button"
                                                        className={`control-pill-btn ${vacState === 'cleaning' ? 'active' : ''}`}
                                                        style={{ flex: 1 }}
                                                        onClick={() => handleVacuumAction(ent.entityId!, 'start')}
                                                    >
                                                        ▶ Start
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={`control-pill-btn ${vacState === 'paused' ? 'active' : ''}`}
                                                        style={{ flex: 1 }}
                                                        onClick={() => handleVacuumAction(ent.entityId!, 'pause')}
                                                    >
                                                        ⏸ Pauze
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={`control-pill-btn ${vacState === 'returning' || vacState === 'docked' ? 'active' : ''}`}
                                                        style={{ flex: 1 }}
                                                        onClick={() => handleVacuumAction(ent.entityId!, 'return_to_base')}
                                                    >
                                                        🏠 Basis
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="control-pill-btn"
                                                        onClick={() => handleVacuumAction(ent.entityId!, 'locate')}
                                                        title="Zoek robotstofzuiger"
                                                    >
                                                        📍
                                                    </button>
                                                </div>
                                                {fanSpeeds.length > 0 && (
                                                    <div style={{ marginTop: '6px' }}>
                                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>💨 Zuigkracht</div>
                                                        <div className="control-pill-grid">
                                                            {fanSpeeds.map(speed => (
                                                                <button
                                                                    key={speed}
                                                                    type="button"
                                                                    className={`control-pill-btn ${curFanSpeed === speed ? 'active' : ''}`}
                                                                    onClick={() => handleVacuumAction(ent.entityId!, 'set_fan_speed', { fan_speed: speed })}
                                                                >
                                                                    {formatHAStateLabel(speed)}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    }

                                    // Light / Switch / Input Boolean / Fan / Humidifier / Lock / Valve / Vacuum / Mower / Siren / Remote
                                    return (
                                        <div key={ent.id} className="control-block">
                                            <div className="control-block-row">
                                                <div className="control-block-label">
                                                    <span>{ent.icon}</span>
                                                    <div>
                                                        <div>{label}</div>
                                                        <div className="control-block-value">
                                                            {ent.type === 'light'
                                                                ? (isOn ? (brightness > 0 ? `Aan • ${brightness}%` : 'Aan') : 'Uit')
                                                                : formatHAStateLabel(ha.state, ha.attributes, ent.entityId)}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div
                                                    className={`toggle-switch ${isOn ? 'on' : ''}`}
                                                    onClick={() => handleToggle(ent.entityId!, ha.state || 'off')}
                                                />
                                            </div>
                                            {ent.type === 'light' && isOn && (
                                                <div style={{ width: '100%' }}>
                                                    <div style={{ width: '100%' }} className="slider-container"
                                                        onClick={(e) => {
                                                            const rect = e.currentTarget.getBoundingClientRect()
                                                            const x = e.clientX - rect.left
                                                            const pct = Math.min(100, Math.max(0, Math.round((x / rect.width) * 100)))
                                                            handleBrightness(ent.entityId!, pct)
                                                        }}
                                                    >
                                                        <div className="slider-fill" style={{ width: `${brightness}%` }}></div>
                                                        <span className="slider-value">Helderheid: {brightness}%</span>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    {/* 2. Parameter Select & Input Select — All Options as Tactile Pill Buttons */}
                    {parameterSelectControls.length > 0 && (
                        <div>
                            <div className="control-section-header">🎛️ Parameters & Opties</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {parameterSelectControls.map(ent => renderSelectCard(ent, false))}
                            </div>
                        </div>
                    )}

                    {/* 3. Action Buttons (button, input_button, scene, script, automation) */}
                    {actionControls.length > 0 && (
                        <div>
                            <div className="control-section-header">▶️ Acties</div>
                            <div className="control-action-grid">
                                {actionControls.map(ent => {
                                    if (!ent.entityId) return null
                                    const ha = entityStates[ent.entityId]
                                    const label = getCleanSubEntityName(ent.name, group.name)
                                    return (
                                        <button
                                            key={ent.id}
                                            type="button"
                                            className="control-action-btn"
                                            onClick={() => handleToggle(ent.entityId!, ha?.state || 'off')}
                                        >
                                            <span>{getActionIcon(label, ent.type)}</span>
                                            <span>{label}</span>
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    {/* 4. Numeric Steppers (number, input_number) */}
                    {numberControls.length > 0 && (
                        <div>
                            <div className="control-section-header">🎚️ Instellingen</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {numberControls.map(ent => {
                                    const ha = ent.entityId ? entityStates[ent.entityId] : undefined
                                    if (!ent.entityId || !ha) return null
                                    const label = getCleanSubEntityName(ent.name, group.name)
                                    const curVal = parseFloat(ha.state)
                                    const minVal = typeof ha.attributes?.min === 'number' ? ha.attributes.min : 0
                                    const maxVal = typeof ha.attributes?.max === 'number' ? ha.attributes.max : 100
                                    const step = typeof ha.attributes?.step === 'number' && ha.attributes.step > 0 ? ha.attributes.step : 1
                                    const unit = ha.attributes?.unit_of_measurement || ''
                                    const safeCur = Number.isFinite(curVal) ? curVal : minVal

                                    const adjust = (delta: number) => {
                                        const next = Math.min(maxVal, Math.max(minVal, Math.round((safeCur + delta) * 100) / 100))
                                        handleNumberValue(ent.entityId!, next)
                                    }

                                    return (
                                        <div key={ent.id} className="control-block">
                                            <div className="control-block-row">
                                                <div className="control-block-label"><span>🎚️</span> {label}</div>
                                                <div className="control-stepper">
                                                    <button type="button" className="stepper-btn" onClick={() => adjust(-step)}>−</button>
                                                    <span className="stepper-val">{safeCur}{unit ? ` ${unit}` : ''}</span>
                                                    <button type="button" className="stepper-btn" onClick={() => adjust(step)}>+</button>
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    {/* 5. Live Status & Sensors Grid (2-column glanceable tiles) */}
                    {sensorEntities.length > 0 && (
                        <div>
                            <div className="control-section-header">📊 Live Status & Sensoren</div>
                            <div className="device-sensor-grid">
                                {sensorEntities.map(ent => {
                                    const ha = ent.entityId ? entityStates[ent.entityId] : undefined
                                    if (!ha) return null
                                    const label = getCleanSubEntityName(ent.name, group.name)
                                    const formatted = formatHAStateLabel(ha.state, ha.attributes, ent.entityId)
                                    return (
                                        <div key={ent.id} className="device-sensor-tile">
                                            <div className="device-sensor-label">{label}</div>
                                            <div className="device-sensor-value">{formatted}</div>
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    {/* 6. Collapsible Diagnostics & HA Entity Inspector */}
                    {(diagEntities.length > 0 || disabledDeviceEntities.length > 0) && (
                        <div>
                            <button
                                type="button"
                                className="diag-accordion-btn"
                                onClick={() => setShowDiagnostics(prev => !prev)}
                            >
                                <span>⚙️ Diagnostiek & HA-entiteiten ({diagEntities.length + disabledDeviceEntities.length})</span>
                                <span>{showDiagnostics ? '▲' : '▼'}</span>
                            </button>
                            {showDiagnostics && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
                                    {diagEntities.length > 0 && (
                                        <div className="device-sensor-grid">
                                            {diagEntities.map(ent => {
                                                const ha = ent.entityId ? entityStates[ent.entityId] : undefined
                                                if (!ha) return null
                                                const label = getCleanSubEntityName(ent.name, group.name)
                                                const formatted = formatHAStateLabel(ha.state, ha.attributes, ent.entityId)
                                                return (
                                                    <div key={ent.id} className="device-sensor-tile" style={{ opacity: 0.88 }}>
                                                        <div className="device-sensor-label">{label}</div>
                                                        <div className="device-sensor-value" style={{ fontSize: '0.86rem' }}>{formatted}</div>
                                                        <div style={{ fontSize: '0.64rem', opacity: 0.5, fontFamily: 'monospace', wordBreak: 'break-all' }}>{ent.entityId}</div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    )}
                                    {disabledDeviceEntities.length > 0 && (
                                        <div style={{ fontSize: '0.74rem', opacity: 0.78, padding: '8px 10px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                                            <div style={{ fontWeight: 600, marginBottom: '4px' }}>Uitgeschakeld in Home Assistant ({disabledDeviceEntities.length}):</div>
                                            {disabledDeviceEntities.map((de: any) => (
                                                <div key={de.entity_id} style={{ fontFamily: 'monospace', fontSize: '0.7rem', opacity: 0.8 }}>
                                                    • {de.entity_id} ({de.disabled_by})
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        )
    }

    useImperativeHandle(ref, () => ({
        importLayoutFromHA
    }))

    // Level 3 takes priority when a device is selected
    if (selectedDevice) {
        return (
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', flex: 1, height: '100%', overflow: 'hidden' }}>
                {renderDeviceControlSheet()}
                {toastMsg && (
                    <div className="toast-notification">
                        {toastMsg}
                    </div>
                )}
            </div>
        )
    }

    // Level 2: Room Detail View (Device Cards)
    if (detailTileId) {
        return (
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', flex: 1, height: '100%', overflow: 'hidden' }}>
                {renderDetailView()}

                {/* Inspector Modal (legacy fallback) */}
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

                {toastMsg && (
                    <div className="toast-notification">
                        {toastMsg}
                    </div>
                )}
            </div>
        )
    }

    // Live search across ALL Home Assistant devices, entities & integrations (grouped by Device!)
    const normalizedSearch = searchQuery.trim().toLowerCase()
    const searchDeviceMatches = normalizedSearch.length >= 2 ? (() => {
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
        const results: Array<{ tileId: string | null; roomName: string; group: DeviceGroup }> = []
        const seenGroupIds = new Set<string>()
        const coveredEntityIds = new Set<string>()

        tiles.forEach(tile => {
            (tile.deviceGroups || []).forEach(group => {
                group.entities.forEach(e => { if (e.entityId) coveredEntityIds.add(e.entityId) })
                const entityHay = group.entities.map(e => `${e.entityId || ''} ${e.name || ''} ${e.platform || ''}`).join(' ')
                const hay = `${group.name || ''} ${group.manufacturer || ''} ${group.model || ''} ${group.platform || ''} ${tile.roomName || ''} ${entityHay}`.toLowerCase()
                if (terms.some(t => hay.includes(t)) && !seenGroupIds.has(group.id)) {
                    seenGroupIds.add(group.id)
                    results.push({ tileId: tile.id, roomName: tile.roomName || 'Home', group })
                }
            })
        })

        // Also scan any live entities not yet in tiles (e.g. brand-new integration before tile rebuild)
        const devById = new Map<string, any>()
        ;(haDevices || []).forEach((d: any) => { if (d?.id) devById.set(d.id, d) })
        const regByEid = new Map<string, any>()
        ;(haEntitiesRegistry || []).forEach((e: any) => { if (e?.entity_id) regByEid.set(e.entity_id, e) })

        availableEntities.forEach(ent => {
            if (coveredEntityIds.has(ent.entity_id)) return
            const reg = regByEid.get(ent.entity_id)
            const dev = reg?.device_id ? devById.get(reg.device_id) : null
            const identPlat = Array.isArray(dev?.identifiers) && Array.isArray(dev.identifiers[0]) ? dev.identifiers[0][0] : ''
            const plat = reg?.platform || dev?.platform || identPlat || ''
            const hay = `${ent.entity_id} ${ent.friendly_name} ${dev?.name_by_user || ''} ${dev?.name || ''} ${dev?.manufacturer || ''} ${dev?.model || ''} ${plat}`.toLowerCase()
            if (terms.some(t => hay.includes(t))) {
                const domain = ent.entity_id.split('.')[0]
                const typeDef = DEVICE_TYPES.find(dt => dt.domain === domain) || { id: 'sensor', icon: '👁️' }
                const roomDev: RoomDevice = {
                    id: `ent-${ent.entity_id}`,
                    type: typeDef.id,
                    name: ent.friendly_name,
                    icon: getApplianceIcon(`${ent.friendly_name} ${ent.entity_id}`, typeDef.icon),
                    entityId: ent.entity_id,
                    platform: plat || undefined
                }
                results.push({
                    tileId: null,
                    roomName: 'Zoeken',
                    group: {
                        id: `search-${ent.entity_id}`,
                        name: ent.friendly_name,
                        platform: plat || undefined,
                        primaryEntity: roomDev,
                        entities: [roomDev]
                    }
                })
            }
        })

        return results.slice(0, 35)
    })() : []

    return (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
            {/* Top Bar + Quick Search */}
            <div className="dashboard-header" style={{ flexWrap: 'wrap', gap: '10px' }}>
                <div>
                    <h1>Home</h1>
                    <div className="connection-status">
                        <span
                            className={`status-dot ${activeConnection ? 'connected' : ''}`}
                            style={activeConnection && haSyncSource === 'cache' ? { background: '#f59e0b', boxShadow: '0 0 8px rgba(245, 158, 11, 0.7)' } : undefined}
                        ></span>
                        {activeConnection
                            ? `${activeConnection.name} • ${availableEntities.length} entiteiten${isSyncingLayout ? ' • Synchroniseren...' : haSyncSource === 'websocket' ? ' • Live (WS)' : haSyncSource === 'rest' ? ' • Live (REST)' : haSyncSource === 'cache' ? ' • Offline (cache)' : ''}`
                            : 'Disconnected'}
                    </div>
                </div>
                {activeConnection && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 220px', maxWidth: '400px', marginLeft: 'auto' }}>
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="🔍 Zoek apparaat of integratie (bv. droogkast, patje)..."
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

            {activeConnection && haSyncSource === 'cache' && haLastError && (
                <div style={{
                    marginBottom: '10px',
                    padding: '9px 12px',
                    borderRadius: '12px',
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                    color: '#fde68a',
                    fontSize: '0.78rem',
                    lineHeight: 1.4
                }}>
                    <strong>⚠️ Offline (oude cache):</strong> {haLastError}. Controleer Wi-Fi/Tailscale of stel een <strong>2e URL</strong> in via <strong>⚙️ Instellingen</strong>.
                </div>
            )}

            {/* Instant Grouped Device Search Results (tap any device to open its full Control Sheet!) */}
            {normalizedSearch.length >= 2 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '0 4px' }}>
                        {searchDeviceMatches.length} apparaten gevonden voor &ldquo;{searchQuery}&rdquo;
                    </div>
                    {searchDeviceMatches.length === 0 ? (
                        <div style={{ padding: '24px', textAlign: 'center', opacity: 0.65, fontSize: '0.88rem' }}>
                            Geen apparaten of integraties gevonden voor &ldquo;{searchQuery}&rdquo;.
                        </div>
                    ) : (
                        <div className="device-group-grid">
                            {searchDeviceMatches.map(({ tileId, roomName, group }) => {
                                const primary = group.primaryEntity || group.entities[0]
                                if (!primary) return null
                                const summary = getDeviceGroupSummary(group)
                                const icon = resolveGroupIcon(group, primary.icon)
                                return (
                                    <div
                                        key={`${tileId || 's'}-${group.id}`}
                                        className={`device-tile-card ${summary.isActive ? 'is-active' : ''}`}
                                        onClick={() => openDeviceSheet(tileId, 'Zoeken', group)}
                                    >
                                        <div className="device-tile-icon">{icon}</div>
                                        <div className="device-tile-meta">
                                            <div className="device-tile-title">{group.name}</div>
                                            <div className="device-tile-sub">
                                                <span>{summary.statusText}</span>
                                                <span style={{ opacity: 0.6 }}>• {roomName}</span>
                                                {group.platform && <span className="integration-pill">{group.platform}</span>}
                                            </div>
                                        </div>
                                        <div className="device-tile-right">
                                            {summary.nonDiagCount > 1 ? (
                                                <span className="device-options-pill">
                                                    {summary.controlCount > 0 ? `🎛️ ${summary.controlCount}` : `📊 ${summary.nonDiagCount}`} ›
                                                </span>
                                            ) : (
                                                <span style={{ opacity: 0.45, fontSize: '1.1rem', fontWeight: 600 }}>›</span>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
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
