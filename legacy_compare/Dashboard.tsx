import React, { useState, useEffect } from 'react'
import { useApp } from '../lib/AppContext'
import { callHAService } from '../utils/home-assistant'
import { HADevice } from '../types'

interface RoomDevice {
    id: string
    type: string
    name: string
    icon: string
    entityId?: string // Linked Home Assistant entity
}

interface DashboardTile {
    id: string
    type: 'room' | 'add'
    roomId?: string
    roomName?: string
    roomIcon?: string
    order: number
    devices?: RoomDevice[]
}

const DEFAULT_TILES: DashboardTile[] = [
    { id: 'bedroom', type: 'room', roomId: 'bedroom', roomName: 'Bedroom', roomIcon: '🛏️', order: 0, devices: [] },
    { id: 'living', type: 'room', roomId: 'living', roomName: 'Living Room', roomIcon: '🛋️', order: 1, devices: [] },
]

const ROOM_ICONS: Record<string, string> = {
    bedroom: '🛏️',
    living: '🛋️',
    kitchen: '🍳',
    bathroom: '🚿',
    office: '💻',
    garage: '🚗',
    garden: '🌱',
    default: '🏠',
}

// Available device types that can be added to a room
const DEVICE_TYPES = [
    { id: 'light', name: 'Light', icon: '💡', description: 'Control lights and brightness', domain: 'light' },
    { id: 'switch', name: 'Switch', icon: '🔌', description: 'Toggle switches on/off', domain: 'switch' },
    { id: 'climate', name: 'Climate', icon: '🌡️', description: 'Temperature and AC control', domain: 'climate' },
    { id: 'media', name: 'Media', icon: '📺', description: 'TV and media players', domain: 'media_player' },
    { id: 'cover', name: 'Blinds/Cover', icon: '🪟', description: 'Curtains and blinds', domain: 'cover' },
    { id: 'fan', name: 'Fan', icon: '🌀', description: 'Fan speed control', domain: 'fan' },
]

export function Dashboard() {
    const { activeConnection, entityStates, haWebSocket } = useApp()
    const [tiles, setTiles] = useState<DashboardTile[]>([])
    const [editMode, setEditMode] = useState(false)
    const [showAddModal, setShowAddModal] = useState(false)
    const [selectedTile, setSelectedTile] = useState<DashboardTile | null>(null) // For managing devices
    const [activeRoom, setActiveRoom] = useState<DashboardTile | null>(null) // For entering the room view
    const [newRoomName, setNewRoomName] = useState('')

    // State for entity linking/editing
    const [availableEntities, setAvailableEntities] = useState<HADevice[]>([])
    const [selectedEntityId, setSelectedEntityId] = useState('')
    const [addingDeviceType, setAddingDeviceType] = useState<typeof DEVICE_TYPES[0] | null>(null)
    const [editingDevice, setEditingDevice] = useState<RoomDevice | null>(null)

    // State for controls
    const [loadingAction, setLoadingAction] = useState<string | null>(null)
    const [isSyncing, setIsSyncing] = useState(false)

    // Load tiles from localStorage
    useEffect(() => {
        const savedTiles = localStorage.getItem('dashboard-tiles')
        if (savedTiles) {
            setTiles(JSON.parse(savedTiles))
        } else {
            setTiles(DEFAULT_TILES)
        }
    }, [])

    // Save tiles to localStorage
    useEffect(() => {
        if (tiles.length > 0) {
            localStorage.setItem('dashboard-tiles', JSON.stringify(tiles))
        }
    }, [tiles])

    // Fetch entities when opening manage modal
    useEffect(() => {
        const fetchEntities = async () => {
            if (activeConnection && (selectedTile || activeRoom) && haWebSocket) {
                try {
                    const response = await haWebSocket.sendMessage({ type: 'get_states' })
                    if (response.success && response.result) {
                        setAvailableEntities(response.result)
                    }
                } catch (err) {
                    console.error('Failed to fetch entities via WS:', err)
                }
            }
        }
        fetchEntities()
    }, [activeConnection, selectedTile, activeRoom, haWebSocket])

    // Auto-Sync on load if connected and using defaults (Fix for fresh installs)
    // Auto-Sync on load (Aggressive)
    useEffect(() => {
        if (activeConnection && haWebSocket && !isSyncing) {
            // Force Sync every time to ensure data is present (User Request)
            const isDefault = true

            if (isDefault || tiles.length === 0) {
                console.log('🔄 Auto-Sync Triggered (Condition-Free)')
                handleSync()
            }
        }
    }, [activeConnection, haWebSocket])

    // Safety Net: If we have entities (from global context) but 0 tiles, Sync Again.
    // This fixes the race condition where AutoSync runs before Context is populated.
    useEffect(() => {
        const entityCount = Object.keys(entityStates).length
        if (activeConnection && entityCount > 0 && tiles.length === 0 && !isSyncing) {
            console.log(`🔄 Safety Sync Triggered (Data Arrived: ${entityCount} entities)`)
            handleSync()
        }
    }, [entityStates, tiles, activeConnection])

    const handleSync = async () => {
        if (!haWebSocket) {
            alert('Not connected to Home Assistant')
            return
        }
        setIsSyncing(true)
        console.log('🔄 Starting Full Sync via WebSocket Registries...')

        try {
            // 1. Fetch Registries in Parallel
            // These commands require general read access (usually available to users)
            // 1. Fetch Registries in Parallel (Settled prevents one failure from killing all)
            const results = await Promise.allSettled([
                haWebSocket.sendMessage({ type: 'config/area_registry/list' }),
                haWebSocket.sendMessage({ type: 'config/entity_registry/list' }),
                haWebSocket.sendMessage({ type: 'config/device_registry/list' }),
                haWebSocket.sendMessage({ type: 'get_states' })
            ])

            const getResult = (res: PromiseSettledResult<any>) =>
                (res.status === 'fulfilled' && res.value?.success) ? res.value.result : []

            const areas = getResult(results[0])
            const registryEntities = getResult(results[1])
            const registryDevices = getResult(results[2])
            let states = getResult(results[3])

            // FALLBACK: If fetch failed but AppContext has data (Chat works), use that.
            if ((!states || states.length === 0) && Object.keys(entityStates).length > 0) {
                console.log('⚠️ Fetch states empty, using AppContext fallback')
                states = Object.values(entityStates)
            }

            // Debug which ones failed
            results.forEach((res, idx) => {
                if (res.status === 'rejected' || (res.status === 'fulfilled' && !res.value?.success)) {
                    console.warn(`Sync Step ${idx} failed`, res)
                }
            })

            console.log(`✅ Sync Partial: ${areas.length} Areas, ${states.length} States`)

            console.log(`✅ Sync Data: ${areas.length} Areas, ${registryEntities.length} RegEnts, ${states.length} States`)

            // 2. Index Data for Lookup
            // Map: AreaID -> Area Object
            const areaMap = new Map<string, any>(areas.map((a: any) => [a.area_id, a]))

            // Map: EntityID -> Registry Entry (contains area_id, device_id)
            const entityRegMap = new Map<string, any>(registryEntities.map((e: any) => [e.entity_id, e]))

            // Map: DeviceID -> Registry Entry (contains area_id)
            const deviceRegMap = new Map<string, any>(registryDevices.map((d: any) => [d.id, d]))

            // 3. Helper Functions
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

            const getIcon = (domain: string): string => {
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

            // 4. Build Room Devices List
            // We group devices by Area ID.
            const areaDevicesMap = new Map<string, RoomDevice[]>()
            // Initialize map for all known areas
            areas.forEach((a: any) => areaDevicesMap.set(a.area_id, []))

            const orphans: RoomDevice[] = []

            for (const stateObj of states) {
                const domain = stateObj.entity_id.split('.')[0]
                const type = getDeviceType(domain)

                // Only include supported types
                if (!type) continue

                const device: RoomDevice = {
                    id: `dev-${stateObj.entity_id.replace('.', '-')}`,
                    type,
                    name: stateObj.attributes.friendly_name || stateObj.entity_id,
                    icon: getIcon(domain),
                    entityId: stateObj.entity_id
                }

                // Determine Area
                let areaId: string | null = null

                // Check Entity Registry
                const entReg = entityRegMap.get(stateObj.entity_id)
                if (entReg) {
                    if (entReg.area_id) {
                        areaId = entReg.area_id
                    } else if (entReg.device_id) {
                        // Fallback to Device Registry
                        const devReg = deviceRegMap.get(entReg.device_id)
                        if (devReg && devReg.area_id) {
                            areaId = devReg.area_id
                        }
                    }
                }

                if (areaId && areaDevicesMap.has(areaId)) {
                    areaDevicesMap.get(areaId)!.push(device)
                } else {
                    orphans.push(device)
                }
            }

            // 5. Construct Tiles
            const newTiles: DashboardTile[] = []

            // Add real rooms
            for (const area of areas) {
                const devices = areaDevicesMap.get(area.area_id) || []

                // Include empty rooms? Yes, if they exist in HA.
                let roomIcon = '🏠'
                const lower = area.name.toLowerCase()
                if (lower.includes('bed')) roomIcon = '🛏️'
                else if (lower.includes('living')) roomIcon = '🛋️'
                else if (lower.includes('kitchen')) roomIcon = '🍳'
                else if (lower.includes('bath')) roomIcon = '🚿'
                else if (lower.includes('garage')) roomIcon = '🚗'
                else if (lower.includes('office')) roomIcon = '💻'
                else if (lower.includes('garden')) roomIcon = '🌱'

                newTiles.push({
                    id: `room-${area.area_id}`,
                    type: 'room',
                    roomId: area.area_id,
                    roomName: area.name,
                    roomIcon,
                    order: newTiles.length,
                    devices
                })
            }

            // Add Default 'All Devices' tile if we found nothing OR just append Orphans
            if (newTiles.length === 0 && orphans.length > 0) {
                newTiles.push({
                    id: 'all-room',
                    type: 'room',
                    roomName: 'All Devices',
                    roomIcon: '🏠',
                    order: 0,
                    devices: orphans
                })
            } else if (orphans.length > 0) {
                // Add orphans to "Unassigned" room?
                // Let's create an "Unassigned" room
                newTiles.push({
                    id: 'room-unassigned',
                    type: 'room',
                    roomId: 'unassigned',
                    roomName: 'Unassigned',
                    roomIcon: '📦',
                    order: newTiles.length,
                    devices: orphans
                })
            }

            console.log('✅ Generated Tiles:', newTiles.length)
            setTiles(newTiles)
            localStorage.setItem('dashboard-tiles', JSON.stringify(newTiles))

        } catch (err) {
            console.error('WS Sync Failed:', err)
            // Error handling silent or debug only now since button is gone
        } finally {
            setIsSyncing(false)
        }
    }

    const handleAddRoom = () => {
        if (!newRoomName.trim()) return

        const newTile: DashboardTile = {
            id: `room-${Date.now()}`,
            type: 'room',
            roomId: newRoomName.toLowerCase().replace(/\s+/g, '-'),
            roomName: newRoomName,
            roomIcon: ROOM_ICONS[newRoomName.toLowerCase()] || ROOM_ICONS.default,
            order: tiles.length,
            devices: [],
        }

        setTiles([...tiles, newTile])
        setNewRoomName('')
        setShowAddModal(false)
    }

    const handleDeleteTile = (tileId: string) => {
        setTiles(tiles.filter(t => t.id !== tileId))
    }

    const handleTileClick = (tile: DashboardTile) => {
        if (editMode) return
        setActiveRoom(tile) // Enter room view
    }

    const handleManageClick = (e: React.MouseEvent, tile: DashboardTile) => {
        e.stopPropagation()
        setSelectedTile(tile) // Open configuration
        // Reset addition/edit state
        setAddingDeviceType(null)
        setEditingDevice(null)
        setSelectedEntityId('')
    }

    const startAddDevice = (deviceType: typeof DEVICE_TYPES[0]) => {
        setAddingDeviceType(deviceType)
        setEditingDevice(null)
        setSelectedEntityId('')
    }

    const startEditDevice = (device: RoomDevice) => {
        const deviceType = DEVICE_TYPES.find(t => t.id === device.type)
        if (deviceType) {
            setAddingDeviceType(deviceType)
            setEditingDevice(device)
            setSelectedEntityId(device.entityId || '')
        }
    }

    const confirmAddOrUpdateDevice = () => {
        if (!selectedTile || !addingDeviceType) return

        const newDevice: RoomDevice = {
            id: editingDevice ? editingDevice.id : `device-${Date.now()}`,
            type: addingDeviceType.id,
            name: addingDeviceType.name,
            icon: addingDeviceType.icon,
            entityId: selectedEntityId || undefined
        }

        const updatedTiles = tiles.map(tile => {
            if (tile.id === selectedTile.id) {
                // If editing, replace the device. If adding, append it.
                const updatedDevices = editingDevice
                    ? (tile.devices || []).map(d => d.id === editingDevice.id ? newDevice : d)
                    : [...(tile.devices || []), newDevice]

                return {
                    ...tile,
                    devices: updatedDevices,
                }
            }
            return tile
        })

        setTiles(updatedTiles)
        // Update selected tile to reflect changes
        const currentTile = updatedTiles.find(t => t.id === selectedTile.id)
        if (currentTile) {
            setSelectedTile(currentTile)
        }

        // Reset state
        setAddingDeviceType(null)
        setEditingDevice(null)
        setSelectedEntityId('')
    }

    const handleRemoveDevice = (deviceId: string) => {
        if (!selectedTile) return

        const updatedTiles = tiles.map(tile => {
            if (tile.id === selectedTile.id) {
                return {
                    ...tile,
                    devices: (tile.devices || []).filter(d => d.id !== deviceId),
                }
            }
            return tile
        })

        setTiles(updatedTiles)
        const currentTile = updatedTiles.find(t => t.id === selectedTile.id)
        if (currentTile) {
            setSelectedTile(currentTile)
        }
    }

    // Action Handlers
    const handleToggle = async (device: RoomDevice, state: boolean) => {
        if (!activeConnection || !device.entityId || !haWebSocket) return

        setLoadingAction(device.id)
        const service = state ? 'turn_on' : 'turn_off'
        const domain = device.entityId.split('.')[0]

        try {
            // Use WebSocket to avoid CORS/Auth issues on Android
            await haWebSocket.sendMessage({
                type: 'call_service',
                domain,
                service,
                service_data: {
                    entity_id: device.entityId
                }
            })
        } catch (err) {
            console.error('Action failed:', err)
        } finally {
            setLoadingAction(null)
        }
    }

    const handleBrightness = async (device: RoomDevice, value: number) => {
        if (!activeConnection || !device.entityId || !haWebSocket) return

        try {
            // Use WebSocket for brightness (Fix CORS on Android)
            await haWebSocket.sendMessage({
                type: 'call_service',
                domain: 'light',
                service: 'turn_on',
                service_data: {
                    entity_id: device.entityId,
                    brightness_pct: value
                }
            })
        } catch (err) {
            console.error('Brightness adjustment failed:', err)
        }
    }

    const renderAddDeviceStep = () => {
        if (!addingDeviceType) return null

        // Filter entities by domain
        const relevantEntities = availableEntities.filter(e =>
            e.entity_id.startsWith(addingDeviceType.domain)
        )

        return (
            <div className="add-device-step">
                <div className="step-header">
                    <button
                        className="back-step-btn"
                        onClick={() => {
                            setAddingDeviceType(null)
                            setEditingDevice(null)
                        }}
                    >
                        ← Back
                    </button>
                    <h3>{editingDevice ? `Edit ${editingDevice.name}` : `Add ${addingDeviceType.name}`}</h3>
                </div>

                <div className="step-content">
                    <label>Select Home Assistant Entity:</label>
                    <select
                        value={selectedEntityId}
                        onChange={(e) => setSelectedEntityId(e.target.value)}
                        className="entity-select"
                    >
                        <option value="">-- Select Entity (Optional) --</option>
                        {relevantEntities.map(e => (
                            <option key={e.entity_id} value={e.entity_id}>
                                {e.attributes.friendly_name || e.entity_id}
                            </option>
                        ))}
                    </select>

                    <div className="step-actions">
                        <button
                            className="confirm-btn"
                            onClick={confirmAddOrUpdateDevice}
                        >
                            {editingDevice ? 'Save Changes' : 'Add Device'}
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    // Render the Room Detail View
    if (activeRoom) {
        return (
            <div className="room-detail-view">
                <div className="room-detail-header">
                    <button className="back-btn" onClick={() => setActiveRoom(null)}>
                        ← Back
                    </button>
                    <div className="room-title">
                        <span className="room-icon">{activeRoom.roomIcon}</span>
                        <h2>{activeRoom.roomName}</h2>
                    </div>
                    <button
                        className="manage-btn"
                        onClick={(e) => handleManageClick(e, activeRoom)}
                    >
                        ⚙️ Manage
                    </button>
                </div>

                <div className="room-controls-grid">
                    {activeRoom.devices && activeRoom.devices.length > 0 ? (
                        activeRoom.devices.map(device => {
                            // Logic for live state: Use entityStates from context if available, fallback OR initial load
                            // actually entityStates is empty initially, so we might want to trust 'availableEntities' on load,
                            // OR better: Just rely on entityStates growing.
                            // BUT: 'availableEntities' is only fetched when manage modal opens. We need initial states for the whole dashboard.
                            // Refactor: We should probably fetch initial states in AppContext or here on mount.
                            // For now, let's use entityStates. If empty, the device might show as off/unknown.

                            const liveState = device.entityId ? entityStates[device.entityId] : null
                            // Helper to extract simple state
                            const isOn = liveState ? liveState.state === 'on' : false
                            const isLoading = loadingAction === device.id

                            // Attributes for sliders etc
                            const attributes = liveState?.attributes || {}

                            return (
                                <div key={device.id} className="control-card">
                                    <div className="control-header">
                                        <span className="control-icon">{device.icon}</span>
                                        <div className="control-info-group">
                                            <span className="control-name">{device.name}</span>
                                            {device.entityId && <span className="entity-id-badge">{device.entityId}</span>}
                                        </div>
                                    </div>
                                    <div className="control-body">
                                        {/* Render controls based on device type */}
                                        {device.type === 'light' && (
                                            <div className="light-controls">
                                                <button
                                                    className={`toggle-btn ${isOn ? 'on' : 'off'} ${isLoading ? 'loading' : ''}`}
                                                    onClick={() => handleToggle(device, !isOn)}
                                                    disabled={!device.entityId || isLoading}
                                                >
                                                    {isLoading ? '...' : (isOn ? 'ON' : 'OFF')}
                                                </button>
                                                <div className="brightness-slider">
                                                    <span>🔆</span>
                                                    <input
                                                        type="range"
                                                        min="0"
                                                        max="100"
                                                        disabled={!isOn || !device.entityId}
                                                        onChange={(e) => handleBrightness(device, parseInt(e.target.value))}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                        {device.type === 'switch' && (
                                            <button
                                                className={`toggle-btn ${isOn ? 'on' : 'off'} ${isLoading ? 'loading' : ''}`}
                                                onClick={() => handleToggle(device, !isOn)}
                                                disabled={!device.entityId || isLoading}
                                            >
                                                {isLoading ? '...' : (isOn ? 'ON' : 'OFF')}
                                            </button>
                                        )}
                                        {device.type === 'climate' && (
                                            <div className="climate-controls">
                                                <div className="temp-display">
                                                    {attributes.temperature || '--'}°C
                                                </div>
                                                <div className="temp-buttons">
                                                    <button>-</button>
                                                    <button>+</button>
                                                </div>
                                            </div>
                                        )}
                                        {device.type === 'media' && (
                                            <div className="media-controls">
                                                <button>⏯</button>
                                            </div>
                                        )}
                                        {['fan', 'cover'].includes(device.type) && (
                                            <div className="generic-controls">
                                                <button
                                                    className="toggle-btn"
                                                    onClick={() => handleToggle(device, !isOn)}
                                                >
                                                    Toggle
                                                </button>
                                            </div>
                                        )}

                                        {!device.entityId && (
                                            <div className="setup-hint" onClick={() => handleManageClick({ stopPropagation: () => { } } as React.MouseEvent, activeRoom)}>
                                                ⚠️ Link entity in Manage
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )
                        })
                    ) : (
                        <div className="empty-room-state">
                            <p>No devices in this room.</p>
                            <button onClick={(e) => handleManageClick(e, activeRoom)}>
                                + Add Devices
                            </button>
                        </div>
                    )}
                </div>
                {/* Configuration Modal (Reused inside room view) */}
                {selectedTile && (
                    <div className="modal-overlay" onClick={() => setSelectedTile(null)}>
                        <div className="modal-content room-config-modal" onClick={e => e.stopPropagation()}>
                            <div className="modal-header">
                                <div className="modal-title">
                                    <span className="modal-icon">{selectedTile.roomIcon}</span>
                                    <h2>{selectedTile.roomName}</h2>
                                </div>
                                <button className="modal-close" onClick={() => setSelectedTile(null)}>✕</button>
                            </div>

                            <div className="room-config-content">
                                {addingDeviceType ? renderAddDeviceStep() : (
                                    <>
                                        {selectedTile.devices && selectedTile.devices.length > 0 && (
                                            <div className="current-devices">
                                                <h3>Devices in this Room</h3>
                                                <div className="device-list">
                                                    {selectedTile.devices.map((device) => (
                                                        <div
                                                            key={device.id}
                                                            className="device-item editable"
                                                            onClick={() => startEditDevice(device)}
                                                            title="Click to edit"
                                                        >
                                                            <span className="device-icon">{device.icon}</span>
                                                            <div className="device-item-info">
                                                                <span className="device-name">{device.name}</span>
                                                                <span className="device-entity">{device.entityId || 'No entity linked (Click to link)'}</span>
                                                            </div>
                                                            <button
                                                                className="remove-device-btn"
                                                                onClick={(e) => {
                                                                    e.stopPropagation()
                                                                    handleRemoveDevice(device.id)
                                                                }}
                                                            >
                                                                ✕
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        <h3>Add Device Type</h3>
                                        <div className="device-type-grid">
                                            {DEVICE_TYPES.map((device) => (
                                                <div key={device.id} className="device-type-card">
                                                    <div className="device-type-icon">{device.icon}</div>
                                                    <div className="device-type-info">
                                                        <h4>{device.name}</h4>
                                                        <p>{device.description}</p>
                                                    </div>
                                                    <button
                                                        className="add-device-btn"
                                                        onClick={() => startAddDevice(device)}
                                                    >
                                                        + Add
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="tiles-section">
            <div className="tiles-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <h2>Rooms</h2>
                    {isSyncing && <span style={{ fontSize: '0.9rem', color: '#3b82f6' }}>🔄 Syncing...</span>}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                        className={`edit-mode-btn ${editMode ? 'active' : ''}`}
                        onClick={() => setEditMode(!editMode)}
                    >
                        {editMode ? '✓ Done' : '✏️ Edit'}
                    </button>
                </div>
            </div>

            <div className="tiles-grid">
                {tiles.map((tile) => (
                    <div
                        key={tile.id}
                        className={`room-tile ${editMode ? 'edit-mode' : ''}`}
                        onClick={() => handleTileClick(tile)}
                    >
                        {editMode && (
                            <button
                                className="tile-delete-btn"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    handleDeleteTile(tile.id)
                                }}
                            >
                                ✕
                            </button>
                        )}
                        <div className="room-tile-header">
                            <div className="room-tile-icon">{tile.roomIcon}</div>
                            <div className="device-count">{tile.devices?.length || 0} devices</div>
                        </div>
                        <div className="room-tile-info">
                            <h3>{tile.roomName}</h3>
                            <p>{tile.devices?.length ? `${tile.devices.length} devices` : 'No devices'}</p>
                        </div>
                        <div className="room-tile-content">
                            <button
                                className="tile-manage-btn"
                                onClick={(e) => handleManageClick(e, tile)}
                            >
                                ⚙️ Configure
                            </button>
                        </div>
                    </div>
                ))}

                <div className="add-tile" onClick={() => setShowAddModal(true)}>
                    <div className="add-tile-icon">+</div>
                    <span>Add Room</span>
                </div>
            </div>

            {/* Configuration Modal (Dashboard Level) */}
            {selectedTile && (
                <div className="modal-overlay" onClick={() => setSelectedTile(null)}>
                    <div className="modal-content room-config-modal" onClick={e => e.stopPropagation()}>
                        {/* ... Same modal content as in Room View ... */}
                        <div className="modal-header">
                            <div className="modal-title">
                                <span className="modal-icon">{selectedTile.roomIcon}</span>
                                <h2>{selectedTile.roomName}</h2>
                            </div>
                            <button className="modal-close" onClick={() => setSelectedTile(null)}>✕</button>
                        </div>

                        <div className="room-config-content">
                            {addingDeviceType ? renderAddDeviceStep() : (
                                <>
                                    {selectedTile.devices && selectedTile.devices.length > 0 && (
                                        <div className="current-devices">
                                            <h3>Devices in this Room</h3>
                                            <div className="device-list">
                                                {selectedTile.devices.map((device) => (
                                                    <div
                                                        key={device.id}
                                                        className="device-item editable"
                                                        onClick={() => startEditDevice(device)}
                                                        title="Click to edit"
                                                    >
                                                        <span className="device-icon">{device.icon}</span>
                                                        <div className="device-item-info">
                                                            <span className="device-name">{device.name}</span>
                                                            <span className="device-entity">{device.entityId || 'No entity linked (Click to link)'}</span>
                                                        </div>
                                                        <button
                                                            className="remove-device-btn"
                                                            onClick={(e) => {
                                                                e.stopPropagation()
                                                                handleRemoveDevice(device.id)
                                                            }}
                                                        >
                                                            ✕
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <h3>Add Device Type</h3>
                                    <div className="device-type-grid">
                                        {DEVICE_TYPES.map((device) => (
                                            <div key={device.id} className="device-type-card">
                                                <div className="device-type-icon">{device.icon}</div>
                                                <div className="device-type-info">
                                                    <h4>{device.name}</h4>
                                                    <p>{device.description}</p>
                                                </div>
                                                <button
                                                    className="add-device-btn"
                                                    onClick={() => startAddDevice(device)}
                                                >
                                                    + Add
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Add Room Modal */}
            {showAddModal && (
                <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <h2>Add New Room</h2>
                        <form onSubmit={(e) => { e.preventDefault(); handleAddRoom(); }}>
                            <input
                                type="text"
                                placeholder="Room name (e.g., Kitchen, Garage)"
                                value={newRoomName}
                                onChange={(e) => setNewRoomName(e.target.value)}
                                autoFocus
                            />
                            <div className="modal-actions">
                                <button type="button" className="cancel-btn" onClick={() => setShowAddModal(false)}>
                                    Cancel
                                </button>
                                <button type="submit" disabled={!newRoomName.trim()}>
                                    Add Room
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    )
}
