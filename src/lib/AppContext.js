import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { HAWebSocket } from '../utils/ha-websocket';
import { Preferences } from '@capacitor/preferences';
import { syncGoogleTokens } from '../utils/auth';
const AppContext = createContext(undefined);
export function AppProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [connections, setConnections] = useState([]);
    const [activeConnection, setActiveConnection] = useState(null);
    const [rooms, setRooms] = useState([]);
    const [chatHistory, setChatHistory] = useState([]);
    const [uiState, setUIState] = useState({
        language: navigator.language || 'en-US',
        labels: {},
        placeholders: {},
        messages: {},
    });
    const [entityStates, setEntityStates] = useState({});
    // HA Data
    const [haWebSocket, setHaWebSocket] = useState(null);
    const [haAreas, setHaAreas] = useState([]);
    const [haDevices, setHaDevices] = useState([]);
    const [haEntitiesRegistry, setHaEntitiesRegistry] = useState([]);
    const [activeSuggestion, setActiveSuggestion] = useState(null);
    useEffect(() => {
        const loadUser = async () => {
            const { data } = await supabase.auth.getSession();
            setUser(data?.session?.user || null);
            if (data?.session)
                syncGoogleTokens(data.session);
            setLoading(false);
        };
        loadUser();
        const { data: { subscription }, } = supabase.auth.onAuthStateChange((_event, session) => {
            setUser(session?.user || null);
            if (session)
                syncGoogleTokens(session);
        });
        return () => subscription?.unsubscribe();
    }, []);
    useEffect(() => {
        if (!user)
            return;
        const loadConnections = async () => {
            const { data } = await supabase
                .from('ha_connections')
                .select('*')
                .eq('user_id', user.id);
            setConnections(data || []);
        };
        loadConnections();
    }, [user]);
    useEffect(() => {
        if (!activeConnection) {
            setRooms([]);
            setEntityStates({});
            return;
        }
        // Sync HA credentials to native widget SharedPreferences
        const syncWidgetCredentials = async () => {
            try {
                await Preferences.set({ key: 'ButlerWidget.ha_url', value: activeConnection.api_url });
                await Preferences.set({ key: 'ButlerWidget.ha_token', value: activeConnection.api_token });
                console.log('📱 Widget credentials synced');
            }
            catch (e) {
                // Preferences not available (web mode) - safe to ignore
            }
        };
        syncWidgetCredentials();
        const loadRooms = async () => {
            const { data } = await supabase
                .from('rooms')
                .select('*')
                .eq('connection_id', activeConnection.id);
            setRooms(data || []);
        };
        loadRooms();
        // 🔌 Initialize WebSocket
        let ws = null;
        const initWebSocket = async () => {
            const { logger } = await import('../utils/logger'); // Dynamic import for safety
            // Define Fetch Data Logic
            const fetchHAData = async () => {
                if (!ws)
                    return;
                try {
                    const { logger } = await import('../utils/logger');
                    logger.info('🔄 Fetching HA Data (States & Registries)...');
                    const [statesRes, areasRes, devicesRes, entitiesRes] = await Promise.all([
                        ws.sendMessage({ type: 'get_states' }),
                        ws.sendMessage({ type: 'config/area_registry/list' }),
                        ws.sendMessage({ type: 'config/device_registry/list' }),
                        ws.sendMessage({ type: 'config/entity_registry/list' })
                    ]);
                    // 1. States
                    if (statesRes.success && Array.isArray(statesRes.result)) {
                        const statesObj = {};
                        statesRes.result.forEach((state) => {
                            statesObj[state.entity_id] = state;
                            // Force sync initial state to DB
                            queueStateUpdate(state.entity_id, state);
                        });
                        setEntityStates(statesObj);
                        logger.info(`✅ Loaded & Queued States: ${statesRes.result.length}`);
                    }
                    else {
                        logger.warn('⚠️ Failed to get states:', statesRes);
                    }
                    // 2. Registries (Store in State)
                    if (areasRes.success) {
                        setHaAreas(areasRes.result);
                        logger.info(`✅ Loaded Areas: ${areasRes.result.length}`);
                    }
                    if (devicesRes.success) {
                        setHaDevices(devicesRes.result);
                        logger.info(`✅ Loaded Devices: ${devicesRes.result.length}`);
                    }
                    if (entitiesRes.success) {
                        setHaEntitiesRegistry(entitiesRes.result);
                        logger.info(`✅ Loaded Entities Reg: ${entitiesRes.result.length}`);
                    }
                    logger.info('✅ HA Metadata Loading Complete');
                }
                catch (err) {
                    const { logger } = await import('../utils/logger');
                    logger.error('❌ Error fetching HA data:', { message: err.message });
                }
            };
            // ==========================================
            // STATE SYNC SERVICE (Batched Updates)
            // ==========================================
            let stateQueue = {};
            let syncTimer = null;
            let lastSyncTime = 0;
            const flushStateQueue = async () => {
                const queueSize = Object.keys(stateQueue).length;
                if (queueSize === 0)
                    return;
                // Prepare batch
                const statesToSync = Object.entries(stateQueue).map(([entity_id, state]) => ({
                    entity_id,
                    state: state.state,
                    attributes: state.attributes
                }));
                // Clear queue immediately to avoid duplicates (optimistic)
                stateQueue = {};
                lastSyncTime = Date.now();
                try {
                    // const { logger } = await import('../utils/logger');
                    // console.log(`[StateSync] Flushing ${statesToSync.length} updates...`, statesToSync);
                    // logger.debug(`[StateSync] Flushing ${statesToSync.length} updates...`);
                    const { error } = await supabase.functions.invoke('mcp-librarian/sync-states', {
                        body: {
                            connection_id: activeConnection.id,
                            states: statesToSync
                        }
                    });
                    if (error)
                        console.error('[StateSync] Sync Error:', error);
                }
                catch (e) {
                    console.error('[StateSync] Failed to sync states:', e);
                    // Retry logic could be added here, but for now we skip to avoid jams
                }
            };
            const queueStateUpdate = (entityId, newState) => {
                // Add to queue
                stateQueue[entityId] = newState;
                // If timer not running, start it
                if (!syncTimer) {
                    syncTimer = setTimeout(() => {
                        syncTimer = null;
                        flushStateQueue();
                    }, 2000); // 2 second debounce/buffer
                }
                // Force flush if queue gets too big (e.g. startup storm)
                if (Object.keys(stateQueue).length > 50) {
                    if (syncTimer)
                        clearTimeout(syncTimer);
                    syncTimer = null;
                    flushStateQueue();
                }
            };
            // Clean up previous connection if any (though effect cleanup handles it)
            // Pass fetchHAData as the onReady callback (4th arg)
            ws = new HAWebSocket(activeConnection.api_url, activeConnection.api_token, (entityId, newState) => {
                // 1. Update React UI
                setEntityStates(prev => ({
                    ...prev,
                    [entityId]: newState
                }));
                // 2. Queue for Cloud Sync
                queueStateUpdate(entityId, newState);
            }, fetchHAData);
            ws.connect()
                .then(async () => {
                const { logger } = await import('../utils/logger');
                logger.info('✅ AppContext WS Connected');
                // fetchHAData is called automatically by onReady
            })
                .catch(err => {
                // For the catch block of connect():
                console.error('❌ AppContext WS Error', err);
            });
            setHaWebSocket(ws);
        };
        initWebSocket();
        return () => {
            if (ws)
                ws.close();
        };
    }, [activeConnection]);
    // Load connection-specific Chat History
    useEffect(() => {
        if (!activeConnection) {
            setChatHistory([]);
            return;
        }
        const loadHistory = async () => {
            console.log('🔄 Loading Chat History for:', activeConnection.id);
            const { data, error } = await supabase
                .from('chat_history')
                .select('*')
                .eq('connection_id', activeConnection.id)
                .order('created_at', { ascending: false })
                .limit(50);
            if (error) {
                console.error('❌ Error loading chat history:', error);
                return;
            }
            if (data) {
                console.log(`✅ Loaded ${data.length} messages.`);
                // Map DB format (json) to UI format (string)
                const mapped = data.reverse().map((d) => {
                    let aiText = "";
                    if (typeof d.ai_response === 'string') {
                        aiText = d.ai_response;
                    }
                    else if (d.ai_response && d.ai_response.text) {
                        aiText = d.ai_response.text;
                    }
                    else {
                        // Fallback for weird formats
                        aiText = JSON.stringify(d.ai_response || "");
                    }
                    return {
                        id: d.id,
                        connection_id: d.connection_id,
                        user_message: d.user_message,
                        ai_response: aiText,
                        language: d.metadata?.language || 'en',
                        actions_taken: d.actions_taken || [],
                        created_at: d.created_at
                    };
                });
                setChatHistory(mapped);
            }
            else {
                console.warn('⚠️ No chat history found.');
            }
        };
        loadHistory();
    }, [activeConnection]);
    const addConnection = (conn) => {
        setConnections([...connections, conn]);
    };
    const deleteConnection = async (id) => {
        await supabase.from('ha_connections').delete().eq('id', id);
        setConnections(connections.filter((c) => c.id !== id));
        if (activeConnection?.id === id) {
            setActiveConnection(null);
        }
    };
    const addRoom = (room) => {
        setRooms([...rooms, room]);
    };
    const deleteRoom = async (id) => {
        await supabase.from('rooms').delete().eq('id', id);
        setRooms(rooms.filter((r) => r.id !== id));
    };
    const updateRoom = async (room) => {
        await supabase.from('rooms').update(room).eq('id', room.id);
        setRooms(rooms.map((r) => (r.id === room.id ? room : r)));
    };
    const updateUIState = (state) => {
        setUIState((prev) => ({ ...prev, ...state }));
    };
    const addChatMessage = (msg) => {
        setChatHistory([...chatHistory, msg]);
    };
    // Voice Trigger State (Global)
    const [shouldTriggerVoice, setShouldTriggerVoice] = useState(false);
    return (_jsx(AppContext.Provider, { value: {
            user,
            loading,
            connections,
            activeConnection,
            rooms,
            chatHistory,
            uiState,
            entityStates,
            haWebSocket,
            haAreas,
            haDevices,
            haEntitiesRegistry,
            activeSuggestion,
            setActiveSuggestion,
            setActiveConnection,
            addConnection,
            deleteConnection,
            addRoom,
            deleteRoom,
            updateRoom,
            updateUIState,
            addChatMessage,
            shouldTriggerVoice,
            setShouldTriggerVoice,
        }, children: children }));
}
export function useApp() {
    const context = useContext(AppContext);
    if (!context) {
        throw new Error('useApp must be used within AppProvider');
    }
    return context;
}
