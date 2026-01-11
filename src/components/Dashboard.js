import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { useApp } from '../lib/AppContext';
import { logger } from '../utils/logger';
import { callHAService } from '../utils/home-assistant';
import './Dashboard.css'; // Import new styles
import { SuggestionPopup } from './SuggestionPopup';
import { supabase } from '../lib/supabase';
const DEFAULT_TILES = [
    { id: 'bedroom', type: 'room', roomId: 'bedroom', roomName: 'Bedroom', roomIcon: '🛏️', order: 0, deviceGroups: [] },
    { id: 'living', type: 'room', roomId: 'living', roomName: 'Living Room', roomIcon: '🛋️', order: 1, deviceGroups: [] },
    { id: 'kitchen', type: 'room', roomId: 'kitchen', roomName: 'Kitchen', roomIcon: '🍳', order: 2, deviceGroups: [] },
    { id: 'office', type: 'room', roomId: 'office', roomName: 'Office', roomIcon: '💻', order: 3, deviceGroups: [] },
];
const ROOM_ICONS = {
    bedroom: '🛏️', living: '🛋️', kitchen: '🍳', bathroom: '🚿',
    office: '💻', garage: '🚗', garden: '🌱', default: '🏠'
};
const DEVICE_TYPES = [
    { id: 'light', name: 'Light', icon: '💡', description: 'Control lights and brightness', domain: 'light' },
    { id: 'switch', name: 'Switch', icon: '🔌', description: 'Toggle switches on/off', domain: 'switch' },
    { id: 'climate', name: 'Climate', icon: '🌡️', description: 'Temperature and AC control', domain: 'climate' },
    { id: 'media', name: 'Media', icon: '📺', description: 'TV and media players', domain: 'media_player' },
    { id: 'cover', name: 'Blinds/Cover', icon: '🪟', description: 'Curtains and blinds', domain: 'cover' },
    { id: 'sensor', name: 'Sensor', icon: '👁️', description: 'Read-only sensors', domain: 'sensor' },
];
export const Dashboard = forwardRef((props, ref) => {
    const { activeConnection, entityStates, haWebSocket, rooms, haAreas, haDevices, haEntitiesRegistry } = useApp();
    console.log('[Dashboard] RENDER. ActiveConnection:', !!activeConnection, 'EntityCount:', Object.keys(entityStates).length);
    // State
    const [tiles, setTiles] = useState(DEFAULT_TILES);
    const [editMode, setEditMode] = useState(false);
    const [showAddRoomModal, setShowAddRoomModal] = useState(false);
    const [newRoomName, setNewRoomName] = useState('');
    const [toastMsg, setToastMsg] = useState(null); // NEW: Toast state
    const [configTileId, setConfigTileId] = useState(null);
    const [showDevicePicker, setShowDevicePicker] = useState(false);
    const [editingDevice, setEditingDevice] = useState(null);
    const [selectedEntityId, setSelectedEntityId] = useState('');
    // Detail Modal State
    const [detailTileId, setDetailTileId] = useState(null);
    const [inspectorData, setInspectorData] = useState(null);
    // Suggestion State
    const [headerSuggestions, setHeaderSuggestions] = useState([]);
    // Auto-Sync Ref
    const hasSyncedRef = useRef(false);
    // Derived State
    const availableEntities = Object.entries(entityStates).map(([id, state]) => ({
        entity_id: id,
        state: state.state,
        attributes: state.attributes,
        friendly_name: state.attributes.friendly_name || id
    }));
    // Load tiles on mount and Sync with DB Rooms
    useEffect(() => {
        if (!activeConnection?.id)
            return;
        const stored = localStorage.getItem(`dashboard_tiles_${activeConnection.id}`);
        let localTiles = stored ? JSON.parse(stored) : [];
        if (rooms.length > 0) {
            const mergedTiles = [...localTiles];
            let changed = false;
            rooms.forEach(dbRoom => {
                // Check for existing by ID, roomId, OR roomName (normalized)
                const normalizedDbName = dbRoom.name?.toLowerCase().trim();
                const exists = mergedTiles.find(t => t.id === dbRoom.id ||
                    t.roomId === dbRoom.id ||
                    t.roomName?.toLowerCase().trim() === normalizedDbName);
                if (!exists) {
                    // Create new tile for this DB room
                    mergedTiles.push({
                        id: dbRoom.id, // Use DB ID
                        type: 'room',
                        roomId: dbRoom.id,
                        roomName: dbRoom.name,
                        roomIcon: Object.entries(ROOM_ICONS).find(([k]) => dbRoom.name.toLowerCase().includes(k))?.[1] || ROOM_ICONS.default,
                        order: mergedTiles.length,
                        deviceGroups: [] // Empty initially
                    });
                    changed = true;
                }
            });
            // Also deduplicate existing tiles by roomName (keep the one with more devices)
            const deduped = [];
            const seenNames = new Map(); // name -> index in deduped
            mergedTiles.forEach(tile => {
                const normName = tile.roomName?.toLowerCase().trim() || tile.id;
                if (seenNames.has(normName)) {
                    // Duplicate found - keep the one with more deviceGroups
                    const existingIdx = seenNames.get(normName);
                    const existing = deduped[existingIdx];
                    if ((tile.deviceGroups?.length || 0) > (existing.deviceGroups?.length || 0)) {
                        deduped[existingIdx] = tile; // Replace with the fuller one
                        changed = true;
                    }
                }
                else {
                    seenNames.set(normName, deduped.length);
                    deduped.push(tile);
                }
            });
            if (changed || (!stored && deduped.length > 0)) {
                setTiles(deduped);
            }
            else if (stored && deduped.length !== mergedTiles.length) {
                // Deduplication happened
                setTiles(deduped);
            }
            else if (stored) {
                setTiles(localTiles);
            }
        }
        else if (stored) {
            setTiles(localTiles);
        }
    }, [activeConnection, rooms]);
    // Save tiles on change
    useEffect(() => {
        if (activeConnection?.id) {
            localStorage.setItem(`dashboard_tiles_${activeConnection.id}`, JSON.stringify(tiles));
        }
    }, [tiles, activeConnection]);
    // Load Pending Suggestions
    useEffect(() => {
        if (!activeConnection?.id)
            return;
        const loadSuggestions = async () => {
            const { data } = await supabase.from('suggestions')
                .select('*')
                .eq('connection_id', activeConnection.id)
                .eq('status', 'pending')
                .order('created_at', { ascending: false });
            if (data && data.length > 0) {
                // @ts-ignore
                setHeaderSuggestions(data);
            }
        };
        loadSuggestions();
    }, [activeConnection]);
    const handleSuggestionAction = async (id, action) => {
        // Optimistic UI
        const target = headerSuggestions.find(s => s.id === id);
        setHeaderSuggestions(prev => prev.filter(s => s.id !== id));
        if (action === 'accept' && target) {
            // Execute the 'create_automation' action immediately (or schedule it)
            // Ideally we call the backend to 'apply' it
            try {
                // Determine if it's an automation create
                const automationAction = target.actions.find((a) => a.type === 'create_automation');
                if (automationAction) {
                    // Insert into automations table
                    const autoData = automationAction.data;
                    await supabase.from('automations').insert({
                        connection_id: activeConnection?.id,
                        alias: autoData.alias,
                        description: autoData.description,
                        trigger: autoData.trigger,
                        action: autoData.action,
                        mode: 'single'
                    });
                    setToastMsg(`✅ Automation "${autoData.alias}" Created!`);
                }
            }
            catch (e) {
                console.error("Failed to apply suggestion", e);
                setToastMsg("❌ Failed to apply suggestion");
            }
        }
        // Update DB Status
        await supabase.from('suggestions').update({ status: action === 'accept' ? 'accepted' : 'rejected' }).eq('id', id);
    };
    // --- Actions ---
    const handleToggle = async (entityId, currentState) => {
        if (!entityId || !activeConnection) {
            logger.warn('Toggle prevented: Missing ID or Connection', { entityId, hasConn: !!activeConnection });
            return;
        }
        try {
            console.log(`🖱️ Toggling ${entityId} (Current: ${currentState})`);
            const domain = entityId.split('.')[0];
            let service = 'turn_on';
            let serviceData = { entity_id: entityId };
            if (domain === 'light' || domain === 'switch' || domain === 'input_boolean') {
                service = 'toggle'; // Use toggle to avoid state sync mismatch
            }
            else if (domain === 'automation') {
                service = 'trigger'; // Automations are triggered, not toggled
            }
            else if (domain === 'script') {
                service = 'turn_on';
            }
            else if (domain === 'media_player') {
                service = 'media_play_pause';
            }
            else if (domain === 'cover') {
                // Simplified Cover Logic: "If it's not closed, close it."
                // This covers 'open', 'opening', 'paused', 'unknown' -> Close
                // Only 'closed' -> Open
                if (currentState === 'closed') {
                    service = 'open_cover';
                }
                else {
                    service = 'close_cover';
                }
            }
            else if (domain === 'lock') {
                service = currentState === 'locked' ? 'unlock' : 'lock';
            }
            await callHAService(domain, service, serviceData, activeConnection.api_url, activeConnection.api_token);
            console.log(`✅ Toggle Sent: ${domain}.${service}`);
            setToastMsg(`Sent: ${service.replace('_', ' ')} to ${entityId}`); // Visual Feedback with ID
            setTimeout(() => setToastMsg(null), 2000);
        }
        catch (error) {
            console.error('Toggle Error:', error);
            setToastMsg(`Error: ${error.message || 'Failed'}`); // Error Feedback
            setTimeout(() => setToastMsg(null), 3000);
            logger.error(`Toggle Failure: ${error.message || error}`, {
                entityId,
                url: error.message?.includes('calling') ? 'See message' : 'Unknown',
                stack: error.stack
            });
        }
    };
    const handleBrightness = async (entityId, level) => {
        if (!entityId || !activeConnection)
            return;
        try {
            console.log(`🔆 Set Brightness ${entityId} -> ${level}%`);
            await callHAService('light', 'turn_on', {
                entity_id: entityId,
                brightness_pct: level
            }, activeConnection.api_url, activeConnection.api_token);
        }
        catch (error) {
            logger.error('Brightness adjustment failed', { entityId, error });
        }
    };
    const handleCoverAction = async (entityId, action) => {
        if (!entityId || !activeConnection)
            return;
        const service = action === 'open' ? 'open_cover' : action === 'close' ? 'close_cover' : 'stop_cover';
        try {
            console.log(`🪟 Cover Action: ${service} -> ${entityId}`);
            await callHAService('cover', service, { entity_id: entityId }, activeConnection.api_url, activeConnection.api_token);
            setToastMsg(`Sent: ${service} to ${entityId}`);
            setTimeout(() => setToastMsg(null), 2000);
        }
        catch (error) {
            console.error('Cover Error:', error);
            setToastMsg(`Error: ${error.message}`);
        }
    };
    // --- Layout Management ---
    const handleAddRoom = () => {
        if (!newRoomName.trim())
            return;
        const newTile = {
            id: `room-${Date.now()}`,
            type: 'room',
            roomName: newRoomName,
            roomIcon: Object.entries(ROOM_ICONS).find(([k]) => newRoomName.toLowerCase().includes(k))?.[1] || ROOM_ICONS.default,
            order: tiles.length,
            deviceGroups: []
        };
        setTiles([...tiles, newTile]);
        setShowAddRoomModal(false);
        setNewRoomName('');
    };
    const handleDeleteRoom = (tileId) => {
        if (window.confirm('Delete this room and all its devices?')) {
            setTiles(tiles.filter(t => t.id !== tileId));
        }
    };
    // --- Device Management ---
    const handleAddDevice = (typeDef) => {
        const newDevice = {
            id: `dev-${Date.now()}`,
            type: typeDef.id,
            name: typeDef.name,
            icon: typeDef.icon,
            entityId: ''
        };
        setEditingDevice(newDevice);
        setSelectedEntityId(''); // Reset selection
        setShowDevicePicker(false); // Close picker, open editor
    };
    const saveDevice = () => {
        if (!configTileId || !editingDevice)
            return;
        const updatedTiles = tiles.map(tile => {
            if (tile.id === configTileId) {
                // Find if this device exists in ANY group
                // For simplified Manual Editing: We assume 1 Group = 1 Device for manual items?
                // Or we create a "Manual Devices" group if none exists?
                // Let's create a dedicated "Manual" group if it doesn't exist
                let groups = [...tile.deviceGroups];
                let manualGroup = groups.find(g => g.id === 'manual-group');
                if (!manualGroup) {
                    manualGroup = {
                        id: 'manual-group',
                        name: 'Manually Added',
                        entities: []
                    };
                    groups.push(manualGroup);
                }
                // Check if device exists in ANY group (could be editing an HA imported one too)
                let found = false;
                const newGroups = groups.map(g => {
                    const existingIndex = g.entities.findIndex(d => d.id === editingDevice.id);
                    if (existingIndex >= 0) {
                        found = true;
                        const updatedEntities = [...g.entities];
                        updatedEntities[existingIndex] = { ...editingDevice, entityId: selectedEntityId };
                        return { ...g, entities: updatedEntities };
                    }
                    return g;
                });
                if (found) {
                    // Updated existing
                    return { ...tile, deviceGroups: newGroups };
                }
                else {
                    // Add to Manual Group
                    const finalDevice = { ...editingDevice, entityId: selectedEntityId };
                    // Update reference to manual group in the newGroups array
                    // We need to re-find manual group in newGroups because we just mapped over it
                    const targetGroupIndex = newGroups.findIndex(g => g.id === 'manual-group');
                    if (targetGroupIndex >= 0) {
                        const updatedEntities = [...newGroups[targetGroupIndex].entities, finalDevice];
                        newGroups[targetGroupIndex] = { ...newGroups[targetGroupIndex], entities: updatedEntities };
                    }
                    return { ...tile, deviceGroups: newGroups };
                }
            }
            return tile;
        });
        setTiles(updatedTiles);
        setEditingDevice(null);
        // Keep config modal open
    };
    const removeDevice = (tileId, groupId, deviceId) => {
        const updatedTiles = tiles.map(tile => {
            if (tile.id === tileId) {
                const newGroups = tile.deviceGroups.map(g => {
                    if (g.id === groupId) {
                        return { ...g, entities: g.entities.filter(d => d.id !== deviceId) };
                    }
                    return g;
                }).filter(g => g.entities.length > 0); // Remove empty groups
                return { ...tile, deviceGroups: newGroups };
            }
            return tile;
        });
        setTiles(updatedTiles);
    };
    // Independent Sync Function
    const performToolSync = (connection, currentEntityStates) => {
        if (!connection)
            return;
        import('../utils/mcp-sync').then(async ({ fetchHAServices, syncBatchToLibrarian }) => {
            try {
                // Ensure we have entities to map against
                const entities = Object.values(currentEntityStates || {}).map((s) => ({
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
                const syncQueue = [];
                Object.entries(allServices).forEach(([domain, services]) => {
                    Object.entries(services).forEach(([svcName, svcData]) => {
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
                    let sync_mode = 'append';
                    if (isFirstBatch)
                        sync_mode = 'start';
                    else if (isLastBatch)
                        sync_mode = 'complete';
                    const batch = syncQueue.slice(i, i + BATCH_SIZE);
                    console.log(`[Dashboard] Processing batch ${batchIndex + 1}/${totalBatches} (mode: ${sync_mode})...`);
                    const batchServices = {};
                    batch.forEach(item => {
                        if (!batchServices[item.domain])
                            batchServices[item.domain] = {};
                        batchServices[item.domain][item.name] = item.service;
                    });
                    const progressPct = Math.round((processedCount / totalCount) * 100);
                    setToastMsg(`🧠 Indexing tools: ${progressPct}% (${processedCount}/${totalCount})`);
                    try {
                        const result = await syncBatchToLibrarian(connection.id, entities, batchServices, sync_mode);
                        if (result.success) {
                            console.log(`[Dashboard] Batch done. Total: ${result.devices} devices, ${result.tools} tools`);
                        }
                        else {
                            console.error('[Dashboard] Batch error:', result.error);
                        }
                    }
                    catch (batchErr) {
                        console.error('[Dashboard] Batch failed:', batchErr);
                    }
                    processedCount += batch.length;
                    await new Promise(r => setTimeout(r, 500));
                }
                console.log('[Dashboard] Sync Complete!');
                setToastMsg(`✅ Sync Complete! ${totalCount} tools ready.`);
            }
            catch (err) {
                console.error('[Dashboard] Sync Failed:', err);
                setToastMsg(`❌ Sync Error: ${err.message}`);
            }
        }).catch((importErr) => {
            console.error('[Dashboard] Failed to import sync module:', importErr);
            setToastMsg('❌ Sync Module Load Failed');
        });
    };
    // Auto-Sync DISABLED - Sync only happens when user clicks "Import from HA"
    // This prevents duplicate entries and unnecessary API calls on every app start
    // NEW: Direct HA Registry Import
    const importLayoutFromHA = () => {
        if (!window.confirm("This will RESET your dashboard and import your exact layout from Home Assistant (Areas & Devices). Continue?"))
            return;
        if (!haAreas || !haDevices || !haEntitiesRegistry) {
            alert("No Home Assistant registry data found. Please wait a moment or check logs.");
            return;
        }
        // 1. Wipe Existing
        let newTiles = [];
        let devicesAddedCount = 0;
        let areasCreatedCount = 0;
        // Helper: Find/Create Tile from Area ID
        const getOrCreateTile = (areaId, areaName, iconOverride) => {
            let tile = newTiles.find(t => t.roomId === areaId);
            if (!tile) {
                // Heuristic Icon mapping based on Area Name
                const lowerName = areaName.toLowerCase();
                const icon = iconOverride || Object.entries(ROOM_ICONS).find(([k]) => lowerName.includes(k))?.[1] || ROOM_ICONS.default;
                tile = {
                    id: areaId,
                    type: 'room',
                    roomId: areaId,
                    roomName: areaName,
                    roomIcon: icon,
                    order: newTiles.length,
                    deviceGroups: []
                };
                newTiles.push(tile);
                areasCreatedCount++;
            }
            return tile;
        };
        const unassignedTile = {
            id: 'unassigned', // Explicit ID for unassigned
            type: 'room',
            roomId: 'unassigned',
            roomName: 'Unassigned',
            roomIcon: '❓',
            order: 999,
            deviceGroups: []
        };
        // --- MAP DATA ---
        // 1. Group Entities by Device ID
        const textEntities = haEntitiesRegistry.filter(e => !e.hidden_by && e.disabled_by === null);
        const deviceMap = new Map();
        const orphans = [];
        textEntities.forEach(regEntity => {
            if (regEntity.device_id) {
                if (!deviceMap.has(regEntity.device_id)) {
                    // Create Group Skeleton
                    const haDevice = haDevices.find(d => d.id === regEntity.device_id);
                    deviceMap.set(regEntity.device_id, {
                        id: regEntity.device_id,
                        name: haDevice?.name_by_user || haDevice?.name || 'Unknown Device',
                        manufacturer: haDevice?.manufacturer,
                        model: haDevice?.model,
                        areaId: haDevice?.area_id || regEntity.area_id, // Device Area Priority, then Entity Area
                        entities: []
                    });
                }
                const group = deviceMap.get(regEntity.device_id);
                const domain = regEntity.entity_id.split('.')[0];
                const typeDef = DEVICE_TYPES.find(dt => dt.domain === domain) || { id: 'sensor', icon: '👁️', name: 'Sensor' };
                group.entities.push({
                    id: `ent-${regEntity.entity_id}`,
                    type: typeDef.id,
                    name: regEntity.name || regEntity.original_name || regEntity.entity_id,
                    icon: typeDef.icon, // Force emoji icon to avoid rendering "mdi:xxx" text
                    entityId: regEntity.entity_id,
                    deviceId: regEntity.device_id,
                    isDiagnostic: regEntity.entity_category === 'diagnostic' || regEntity.entity_category === 'config' ||
                        regEntity.entity_id.includes('_battery') || regEntity.entity_id.includes('_firmware') ||
                        regEntity.entity_id.includes('_update') || regEntity.entity_id.includes('_signal_strength')
                });
                // Update Area if not set on device but set on entity
                if (!group.areaId && regEntity.area_id) {
                    group.areaId = regEntity.area_id;
                }
            }
            else {
                orphans.push(regEntity);
            }
        });
        // 2. Process Device Groups -> Tiles
        deviceMap.forEach(group => {
            // Determine Primary Entity for Summary View
            // Priority: Light > Switch > Cover > Climate > Sensor
            const getScore = (e) => {
                if (e.entityId?.startsWith('light'))
                    return 10;
                if (e.entityId?.startsWith('switch'))
                    return 9;
                if (e.entityId?.startsWith('cover'))
                    return 8;
                if (e.entityId?.startsWith('climate'))
                    return 7;
                if (e.entityId?.startsWith('lock'))
                    return 6;
                if (e.entityId?.startsWith('media_player'))
                    return 5;
                return 0;
            };
            group.entities.sort((a, b) => getScore(b) - getScore(a));
            group.primaryEntity = group.entities[0];
            // Assign to Area
            let tile;
            if (group.areaId) {
                const area = haAreas.find(a => a.area_id === group.areaId);
                tile = getOrCreateTile(group.areaId, area?.name || 'Unknown Area');
            }
            else {
                tile = unassignedTile;
            }
            tile.deviceGroups.push(group);
            devicesAddedCount++;
        });
        // 3. Process Orphans (Entities without Devices)
        orphans.forEach(orp => {
            const domain = orp.entity_id.split('.')[0];
            if (domain === 'sun' || domain === 'weather')
                return; // processed later if we want special tiles
            const typeDef = DEVICE_TYPES.find(dt => dt.domain === domain) || { id: 'sensor', icon: '👁️', name: 'Sensor' };
            // Create a "Virtual Device" for this orphan
            const virtualGroup = {
                id: `orp-${orp.entity_id}`,
                name: orp.name || orp.original_name || orp.entity_id,
                entities: [{
                        id: `ent-${orp.entity_id}`,
                        type: typeDef.id,
                        name: orp.name || orp.original_name || orp.entity_id,
                        icon: typeDef.icon, // Force emoji icon
                        entityId: orp.entity_id
                    }]
            };
            virtualGroup.primaryEntity = virtualGroup.entities[0];
            let tile;
            if (orp.area_id) {
                const area = haAreas.find(a => a.area_id === orp.area_id);
                tile = getOrCreateTile(orp.area_id, area?.name || 'Unknown Area');
            }
            else {
                tile = unassignedTile;
            }
            tile.deviceGroups.push(virtualGroup);
            devicesAddedCount++;
        });
        // 4. Final Sort
        if (devicesAddedCount > 0) {
            if (unassignedTile.deviceGroups.length > 0)
                newTiles.push(unassignedTile);
            newTiles.sort((a, b) => {
                if (a.id === 'unassigned')
                    return 1;
                if (b.id === 'unassigned')
                    return -1;
                return (a.roomName || '').localeCompare(b.roomName || '');
            });
            newTiles.forEach(tile => {
                tile.deviceGroups.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            });
            setTiles(newTiles);
            // === NEW: Sync to MCP Librarian (Client-Orchestrated Batching) ===
            // This builds the Custom MCP Server with properly formatted tools
            // === NEW: Trigger Sync ===
            // === NEW: Trigger Sync ===
            if (activeConnection) {
                performToolSync(activeConnection, entityStates);
            }
            alert(`Import Complete!\nCreated ${areasCreatedCount} areas.\nMapped ${devicesAddedCount} devices from Home Assistant.`);
        }
        else {
            alert("No matching entities found in your HA registries.");
        }
    };
    const openRoomConfig = (tileId) => {
        setConfigTileId(tileId);
        setEditingDevice(null);
        setShowDevicePicker(false);
    };
    // --- Render Helpers ---
    const renderSlider = (entityId, currentBri) => {
        // Simple click-to-set slider simulation
        return (_jsxs("div", { className: "slider-container", onClick: (e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const pct = Math.min(100, Math.max(0, Math.round((x / rect.width) * 100)));
                handleBrightness(entityId, pct);
            }, children: [_jsx("div", { className: "slider-fill", style: { width: `${currentBri}%` } }), _jsxs("span", { className: "slider-value", children: [currentBri, "%"] })] }));
    };
    // --- UI Helpers ---
    const getDevicePriority = (type) => {
        // High priority: Controls that do things
        if (['light', 'switch', 'lock', 'cover', 'climate', 'media', 'input_boolean', 'automation'].includes(type))
            return 0;
        // Medium: Binary Sensors (often security/occupancy)
        if (type === 'binary_sensor')
            return 1;
        // Low: Read-only sensors
        return 2;
    };
    // New: Render merged layout (Device List)
    const renderRoomCard = (tile) => {
        // 1. Flatten for "Header Sensors" check (Temp/Hum)
        // We look for any entity in any group that matches
        let temp;
        let hum;
        if (tile.id !== 'unassigned') {
            const allEntities = tile.deviceGroups.flatMap(g => g.entities).map(d => ({ config: d, ha: entityStates[d.entityId || ''] }));
            // Helper: Avoid batteries and non-relevant sensors
            const isValidEnv = (d) => {
                const id = d.config.entityId?.toLowerCase() || '';
                // Exclude battery, power, signal, and hardware/system temps (cpu, wifi, etc)
                if (id.includes('battery') || id.includes('power') || id.includes('signal') ||
                    id.includes('cpu') || id.includes('processor') || id.includes('wifi') ||
                    id.includes('uptime') || id.includes('device_temp'))
                    return false;
                const state = parseFloat(d.ha?.state);
                return !isNaN(state);
            };
            temp = allEntities.find(d => (d.config.type === 'climate' || d.ha?.attributes?.device_class === 'temperature') &&
                isValidEnv(d));
            hum = allEntities.find(d => d.ha?.attributes?.device_class === 'humidity' &&
                isValidEnv(d));
        }
        const tempVal = temp?.ha?.state;
        const tempUnit = temp?.ha?.attributes?.unit_of_measurement || '';
        const humVal = hum?.ha?.state;
        const humUnit = hum?.ha?.attributes?.unit_of_measurement || '';
        return (_jsxs("div", { className: "room-card", onClick: () => setDetailTileId(tile.id), children: [editMode && (_jsx("button", { className: "tile-delete-btn", onClick: (e) => { e.stopPropagation(); handleDeleteRoom(tile.id); }, children: "\u2715" })), _jsx("div", { className: "room-header", children: _jsxs("div", { className: "room-title", children: [_jsx("span", { style: { fontSize: '1.5rem' }, children: (tile.id.includes('weather') && entityStates['sun.sun']) ?
                                    (entityStates['sun.sun'].state === 'below_horizon' ? '🌙' : '☀️')
                                    : tile.roomIcon }), _jsx("span", { style: { fontSize: '1.2rem', fontWeight: 600 }, children: tile.roomName }), (tempVal || humVal) && (_jsxs("span", { style: { marginLeft: 12, fontSize: '0.9rem', opacity: 0.7, fontWeight: 400 }, children: [tempVal && _jsxs("span", { children: [tempVal, tempUnit] }), tempVal && humVal && _jsx("span", { style: { margin: '0 6px' }, children: "\u2022" }), humVal && _jsxs("span", { children: [humVal, humUnit] })] }))] }) }), tile.id === 'unassigned' ? (_jsxs("div", { style: { padding: '20px 0', textAlign: 'center', opacity: 0.6 }, children: [_jsx("div", { style: { fontSize: '2rem', marginBottom: 8 }, children: "\uD83D\uDCE6" }), _jsxs("div", { children: [tile.deviceGroups.length, " Unassigned Items"] }), _jsx("div", { style: { fontSize: '0.8rem' }, children: "(Tap to view)" })] })) : (_jsxs("div", { className: "room-entity-list", style: { marginTop: 8 }, children: [tile.deviceGroups.length === 0 && (_jsx("div", { style: { opacity: 0.5, fontSize: '0.8rem', padding: '10px 0' }, children: "No devices found." })), [...tile.deviceGroups]
                            .filter(g => {
                            const type = g.primaryEntity?.type;
                            const id = g.primaryEntity?.entityId?.toLowerCase() || '';
                            const name = g.primaryEntity?.name?.toLowerCase() || '';
                            // Always keep controls
                            if (type !== 'sensor' && type !== 'binary_sensor')
                                return true;
                            // Whitelist: Season, Day/Night, Trackers
                            if (id.includes('season') ||
                                id.includes('sun') ||
                                id.includes('day') ||
                                id.includes('night') ||
                                id.includes('mode') ||
                                // Lost items / Trackers
                                name.includes('lost') ||
                                name.includes('tracker') ||
                                name.includes('tile') ||
                                name.includes('tag') ||
                                id.includes('tracker') ||
                                id.includes('device_tracker') ||
                                // Doors / Windows / Gates
                                name.includes('door') ||
                                name.includes('window') ||
                                name.includes('gate') ||
                                name.includes('entry') ||
                                id.includes('door') ||
                                id.includes('window')) {
                                return true;
                            }
                            return false;
                        })
                            .sort((a, b) => {
                            const typeA = a.primaryEntity?.type || 'sensor';
                            const typeB = b.primaryEntity?.type || 'sensor';
                            const priA = getDevicePriority(typeA);
                            const priB = getDevicePriority(typeB);
                            if (priA !== priB)
                                return priA - priB;
                            return a.name.localeCompare(b.name);
                        })
                            .map(group => {
                            // Show the Primary Entity if available, otherwise just the first entity
                            const primary = group.primaryEntity || group.entities[0];
                            if (!primary)
                                return null;
                            const ha = entityStates[primary.entityId || ''];
                            // Don't hide if missing state, show placeholder?
                            // if (!ha) return null 
                            // Filtering logic same as before but per device group presentation
                            // If the Primary is the temp sensor shown in header, do we hide the whole device?
                            // Maybe not, because the device might have OTHER entities.
                            // But for room summary card, we only show ONE line per device generally.
                            /*
                               DECISION: On the Room Card (Summary), show only the Primary Entity of the Device.
                               If the primary entity is HIDDEN (e.g. it's the temp sensor we moved to header),
                               we should show the Secondary entity?
                               No, let's just keep it simple. If it's in the header, we might duplicate it or just ignore.
                               Duplicates are fine for full control.
                            */
                            const config = primary;
                            const isSensor = config.type === 'sensor' || config.type === 'climate';
                            const isActive = ha?.state === 'on' || ha?.state === 'playing' || ha?.state === 'open';
                            const isWarm = isSensor && (ha?.attributes?.device_class === 'temperature');
                            // Formatting State
                            let stateDisplay = ha?.state || 'Unknown';
                            // Sun formatting
                            if (config.entityId === 'sun.sun') {
                                stateDisplay = ha?.state === 'above_horizon' ? 'Day' : 'Night';
                            }
                            // Proper Door/Window text for binary sensors (Broad check)
                            else if ((config.type === 'binary_sensor' || config.entityId?.includes('door') || config.entityId?.includes('window')) && (config.entityId?.includes('door') ||
                                config.entityId?.includes('window') ||
                                config.entityId?.includes('opening') ||
                                ha?.attributes?.device_class === 'door' ||
                                ha?.attributes?.device_class === 'window' ||
                                ha?.attributes?.device_class === 'garage_door')) {
                                stateDisplay = ha.state === 'on' ? 'Open' : 'Closed';
                            }
                            else if (config.type === 'light')
                                stateDisplay = isActive ? 'On' : 'Off';
                            // Cover Percentage
                            else if (config.type === 'cover') {
                                if (ha?.state === 'open' && ha.attributes?.current_position !== undefined) {
                                    stateDisplay = `Open (${ha.attributes.current_position}%)`;
                                }
                                else {
                                    stateDisplay = ha?.state === 'open' ? 'Open' : ha?.state === 'closed' ? 'Closed' : ha?.state || 'Unknown';
                                }
                            }
                            if (ha?.attributes?.unit_of_measurement)
                                stateDisplay += ` ${ha.attributes.unit_of_measurement}`;
                            // General Text Cleanup (Capitalize, replace underscores)
                            if (!ha?.attributes?.unit_of_measurement && stateDisplay.includes('_')) {
                                stateDisplay = stateDisplay.replace(/_/g, ' ');
                            }
                            // Capitalize if simple word and not already formatted
                            if (!ha?.attributes?.unit_of_measurement && stateDisplay.length < 20 && !stateDisplay.includes('(')) {
                                stateDisplay = stateDisplay.charAt(0).toUpperCase() + stateDisplay.slice(1);
                            }
                            // Motion
                            if (config.id.includes('motion'))
                                stateDisplay = isActive ? 'Detected' : 'Clear';
                            return (_jsxs("div", { className: "entity-row", onClick: e => {
                                    // Navigate to detail view on click (handled by parent div, but explicit here?)
                                    // Actually, parent div `room-card` has onClick => setDetailTileId.
                                    // Clicking a specific row could just propagate to parent.
                                    // UNLESS it's a switch we want to toggle.
                                    if (!isSensor)
                                        e.stopPropagation(); // But if we stop prop, we can't open detail?
                                    // Wait, usually clicking the row opens the detail (more sensors),
                                    // clicking the Toggle Switch toggles.
                                    // So we SHOULD propagate unless it's the toggle button itself.
                                }, children: [_jsxs("div", { className: "entity-main", children: [_jsx("div", { className: `entity-icon ${isActive ? 'active' : ''} ${isWarm ? 'warm' : ''}`, children: config.icon }), _jsx("div", { className: "entity-name", children: config.name || group.name })] }), !isSensor ? (_jsx("div", { className: `toggle-switch compact ${isActive ? 'on' : ''}`, onClick: (e) => {
                                            e.stopPropagation();
                                            handleToggle(config.entityId, ha?.state || 'off');
                                        } })) : (_jsx("div", { className: "entity-state", children: stateDisplay }))] }, group.id));
                        })] }))] }, tile.id));
    };
    // UPDATED: Inline Detail View (Not Modal)
    const renderDetailView = () => {
        const tile = tiles.find(t => t.id === detailTileId);
        if (!tile)
            return null;
        // 1. Flatten all entities from groups
        const allEntities = tile.deviceGroups.flatMap(g => g.entities);
        // 2. Categorize
        // Split Primary vs Diagnostic
        const primaryDevices = allEntities.filter(d => !d.isDiagnostic);
        const diagnosticDevices = allEntities.filter(d => d.isDiagnostic);
        const covers = primaryDevices.filter(e => e.type === 'cover');
        const controls = primaryDevices.filter(e => e.type === 'light' || e.type === 'switch' || e.type === 'input_boolean' || e.type === 'lock' || e.type === 'media');
        const sensors = primaryDevices.filter(e => e.type === 'sensor' || e.type === 'binary_sensor');
        const renderCard = (config) => {
            const ha = entityStates[config.entityId || ''];
            if (!ha)
                return null;
            const isOn = ha.state === 'on' || ha.state === 'playing' || ha.state === 'open';
            const isLight = config.type === 'light';
            const isCover = config.type === 'cover';
            const isSensor = config.type === 'sensor' || config.type === 'binary_sensor';
            const brightness = ha.attributes?.brightness ? Math.round((ha.attributes.brightness / 255) * 100) : 0;
            // Check if this device has associated diagnostics
            const myDiagnostics = diagnosticDevices.filter(d => d.deviceId === config.deviceId);
            // Value Display
            let valueDisplay = ha.state;
            if (ha.attributes?.unit_of_measurement)
                valueDisplay += ` ${ha.attributes.unit_of_measurement}`;
            if (isCover)
                valueDisplay = ha.state === 'open' ? 'Open' : ha.state === 'closed' ? 'Closed' : ha.state;
            if (brightness > 0 && isLight)
                valueDisplay += ` • ${brightness}%`;
            if (isOn && !isSensor && !isCover)
                valueDisplay = 'On';
            if (!isOn && !isSensor && !isCover)
                valueDisplay = 'Off';
            // Icon Color
            const iconColor = isOn || (isCover && ha.state === 'open') ? 'var(--accent)' : 'var(--text-secondary)';
            return (_jsxs("div", { className: "detail-card", style: { position: 'relative' }, children: [_jsxs("div", { className: "detail-card-header", children: [_jsx("div", { className: "detail-icon", style: { color: iconColor }, children: config.icon }), _jsxs("div", { className: "detail-info", children: [_jsx("div", { className: "detail-name", children: config.name }), _jsx("div", { className: "detail-state", children: valueDisplay })] }), (isLight || config.type === 'switch') && (_jsx("div", { className: `toggle-switch compact ${isOn ? 'on' : ''} detail-toggle`, onClick: (e) => { e.stopPropagation(); handleToggle(config.entityId, ha.state || 'off'); } }))] }), isCover && (_jsxs("div", { className: "detail-controls-row", style: { paddingLeft: myDiagnostics.length > 0 ? 32 : 0 }, children: [_jsx("div", { className: "control-btn-icon", onClick: (e) => { e.stopPropagation(); handleCoverAction(config.entityId, 'open'); }, children: "\u2B06" }), _jsx("div", { className: "control-btn-icon", onClick: (e) => { e.stopPropagation(); handleCoverAction(config.entityId, 'stop'); }, children: "\u23F9" }), _jsx("div", { className: "control-btn-icon", onClick: (e) => { e.stopPropagation(); handleCoverAction(config.entityId, 'close'); }, children: "\u2B07" })] })), isLight && isOn && (_jsx("div", { style: { marginTop: 'auto', padding: '8px 0', paddingLeft: myDiagnostics.length > 0 ? 32 : 0 }, children: renderSlider(config.entityId, brightness) })), myDiagnostics.length > 0 && (_jsx("div", { style: {
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
                        }, onClick: (e) => {
                            e.stopPropagation();
                            setInspectorData({ name: config.name, diagnostics: myDiagnostics });
                        }, children: "\u2139\uFE0F" }))] }, config.id));
        };
        return (_jsxs("div", { className: "detail-view", style: {
                background: 'var(--bg-card)',
                borderRadius: '24px',
                border: '1px solid var(--border)',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                flex: 1,
                width: '100%' // Ensure full width
            }, children: [_jsxs("div", { className: "detail-header", style: { display: 'flex', alignItems: 'center', marginBottom: '24px', gap: '16px' }, children: [_jsx("button", { onClick: () => setDetailTileId(null), style: { background: 'transparent', fontSize: '1.2rem', padding: 8, color: 'var(--text-primary)' }, children: "\u2B05" }), _jsxs("h2", { style: { margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)' }, children: [tile.roomIcon, " ", tile.roomName] }), _jsx("button", { className: "configure-btn", onClick: () => { setDetailTileId(null); openRoomConfig(tile.id); }, style: { marginLeft: 'auto' }, children: "\u2699\uFE0F Config" })] }), _jsxs("div", { className: "device-list-scroller", style: { padding: '0 4px' }, children: [covers.length > 0 && (_jsxs("div", { className: "detail-section", children: [_jsxs("div", { className: "detail-section-title", children: [_jsx("span", { children: "\uD83E\uDE9F" }), " Coverings"] }), _jsx("div", { className: "detail-grid", children: covers.map(renderCard) })] })), controls.length > 0 && (_jsxs("div", { className: "detail-section", children: [_jsxs("div", { className: "detail-section-title", children: [_jsx("span", { children: "\u26A1" }), " Controls"] }), _jsx("div", { className: "detail-grid", children: controls.map(renderCard) })] })), sensors.length > 0 && (_jsxs("div", { className: "detail-section", children: [_jsxs("div", { className: "detail-section-title", children: [_jsx("span", { children: "\uD83D\uDC41\uFE0F" }), " Sensors"] }), _jsx("div", { className: "detail-grid", children: sensors.map(renderCard) })] })), !covers.length && !controls.length && !sensors.length && (_jsx("div", { style: { textAlign: 'center', opacity: 0.5, marginTop: 40 }, children: "No devices found in this room." }))] })] }));
    };
    useImperativeHandle(ref, () => ({
        importLayoutFromHA
    }));
    if (detailTileId) {
        return (_jsxs("div", { style: { width: '100%', display: 'flex', flexDirection: 'column', flex: 1, height: '100%', overflow: 'hidden' }, children: [renderDetailView(), inspectorData && (_jsx("div", { className: "modal-overlay", onClick: () => setInspectorData(null), children: _jsxs("div", { className: "modal-content", onClick: e => e.stopPropagation(), style: { maxWidth: 400 }, children: [_jsxs("div", { className: "modal-header", children: [_jsxs("h2", { children: [inspectorData.name, " Details"] }), _jsx("button", { onClick: () => setInspectorData(null), children: "\u2715" })] }), _jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 12 }, children: inspectorData.diagnostics.length === 0 ? (_jsx("div", { style: { opacity: 0.5, textAlign: 'center' }, children: "No diagnostics available." })) : (inspectorData.diagnostics.map(d => {
                                    const ha = entityStates[d.entityId || ''];
                                    if (!ha)
                                        return null;
                                    let val = ha.state;
                                    if (ha.attributes?.unit_of_measurement)
                                        val += ` ${ha.attributes.unit_of_measurement}`;
                                    return (_jsx("div", { className: "device-row", children: _jsxs("div", { style: { flex: 1 }, children: [_jsx("div", { className: "device-name", children: d.entityId }), _jsx("div", { className: "device-state", style: { fontSize: '0.9rem', color: 'var(--accent)' }, children: val })] }) }, d.id));
                                })) })] }) }))] }));
    }
    return (_jsxs("div", { style: { width: '100%', display: 'flex', flexDirection: 'column', flex: 1 }, children: [_jsx("div", { className: "dashboard-header", children: _jsxs("div", { children: [_jsx("h1", { children: "Home" }), _jsxs("div", { className: "connection-status", children: [_jsx("span", { className: `status-dot ${activeConnection ? 'connected' : ''}` }), activeConnection ? activeConnection.name : 'Disconnected'] })] }) }), _jsxs("div", { className: "room-grid", children: [tiles.sort((a, b) => a.order - b.order).map(tile => renderRoomCard(tile)), editMode && (_jsxs("div", { className: "room-card add-room", onClick: () => setShowAddRoomModal(true), children: [_jsx("div", { style: { fontSize: '2rem' }, children: "+" }), _jsx("div", { children: "Add Room" })] }))] }), configTileId && (_jsx("div", { className: "modal-overlay", onClick: () => setConfigTileId(null), children: _jsxs("div", { className: "modal-content", onClick: e => e.stopPropagation(), children: [_jsxs("div", { className: "modal-header", children: [_jsx("h2", { children: "Configure Room" }), _jsx("button", { onClick: () => setConfigTileId(null), children: "\u2715" })] }), !editingDevice ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "device-list", children: [_jsx("h3", { children: "Devices" }), tiles.find(t => t.id === configTileId)?.deviceGroups.flatMap(g => g.entities).map(device => (_jsxs("div", { className: "device-row", children: [_jsxs("span", { children: [device.icon, " ", device.name] }), _jsxs("div", { children: [_jsx("button", { onClick: () => {
                                                                setEditingDevice(device);
                                                                setSelectedEntityId(device.entityId || '');
                                                            }, children: "Edit" }), _jsx("button", { className: "delete-btn", onClick: () => removeDevice(configTileId, 'manual-group', device.id), children: "Remove" })] })] }, device.id))), (!tiles.find(t => t.id === configTileId)?.deviceGroups.length) && _jsx("p", { children: "No devices." })] }), _jsx("div", { className: "modal-actions", children: _jsx("button", { className: "primary-btn", onClick: () => setShowDevicePicker(true), children: "+ Add Device" }) })] })) : (_jsxs("div", { className: "device-editor", children: [_jsxs("div", { className: "form-group", children: [_jsx("label", { children: "Name" }), _jsx("input", { value: editingDevice.name, onChange: e => setEditingDevice({ ...editingDevice, name: e.target.value }) })] }), _jsxs("div", { className: "form-group", children: [_jsx("label", { children: "Entity ID" }), _jsxs("select", { value: selectedEntityId, onChange: e => setSelectedEntityId(e.target.value), children: [_jsx("option", { value: "", children: "Select Entity..." }), availableEntities.sort((a, b) => a.entity_id.localeCompare(b.entity_id)).map(e => (_jsxs("option", { value: e.entity_id, children: [e.friendly_name, " (", e.entity_id, ")"] }, e.entity_id)))] })] }), _jsxs("div", { className: "modal-actions", children: [_jsx("button", { onClick: () => setEditingDevice(null), children: "Cancel" }), _jsx("button", { className: "primary-btn", onClick: saveDevice, children: "Save" })] })] }))] }) })), showDevicePicker && (_jsx("div", { className: "modal-overlay", onClick: () => setShowDevicePicker(false), children: _jsxs("div", { className: "modal-content", onClick: e => e.stopPropagation(), children: [_jsx("h3", { children: "Select Device Type" }), _jsx("div", { className: "device-type-grid", children: DEVICE_TYPES.map(type => (_jsxs("div", { className: "device-type-card", onClick: () => handleAddDevice(type), children: [_jsx("div", { style: { fontSize: '2rem' }, children: type.icon }), _jsx("div", { children: type.name })] }, type.id))) })] }) })), showAddRoomModal && (_jsx("div", { className: "modal-overlay", onClick: () => setShowAddRoomModal(false), children: _jsxs("div", { className: "modal-content", onClick: e => e.stopPropagation(), children: [_jsx("h3", { children: "Add New Room" }), _jsx("input", { placeholder: "Room Name", value: newRoomName, onChange: e => setNewRoomName(e.target.value), onKeyDown: e => e.key === 'Enter' && handleAddRoom() }), _jsxs("div", { className: "modal-actions", children: [_jsx("button", { onClick: () => setShowAddRoomModal(false), children: "Cancel" }), _jsx("button", { className: "primary-btn", onClick: handleAddRoom, children: "Add" })] })] }) })), toastMsg && (_jsx("div", { className: "toast-notification", children: toastMsg })), headerSuggestions.length > 0 && (_jsx(SuggestionPopup, { suggestions: headerSuggestions, onClose: () => setHeaderSuggestions([]), onAction: handleSuggestionAction }))] }));
});
