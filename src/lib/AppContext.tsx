import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from './supabase'
import { HAConnection, Room, UIState, ChatMessage, Suggestion } from '../types'
import { HAWebSocket } from '../utils/ha-websocket'
import { Preferences } from '@capacitor/preferences'
import { syncGoogleTokens } from '../utils/auth'
import { buildHAUrl, sanitizeHAToken, fetchWithTimeout } from '../utils/home-assistant'
import { clearPushTokenForConnection } from '../utils/pushNotifications'

interface AppContextType {
  user: any
  loading: boolean
  connections: HAConnection[]
  activeConnection: HAConnection | null
  rooms: Room[]
  chatHistory: ChatMessage[]
  uiState: UIState
  entityStates: Record<string, any>
  haWebSocket: HAWebSocket | null
  haAreas: any[]
  haDevices: any[]
  haEntitiesRegistry: any[]

  activeSuggestion: Suggestion | null
  setActiveSuggestion: (suggestion: Suggestion | null) => void
  setActiveConnection: (conn: HAConnection | null) => void
  addConnection: (conn: HAConnection) => void
  deleteConnection: (id: string) => Promise<void>
  addRoom: (room: Room) => void
  deleteRoom: (id: string) => Promise<void>
  updateRoom: (room: Room) => Promise<void>
  updateUIState: (state: Partial<UIState>) => void
  addChatMessage: (msg: ChatMessage) => void
  shouldTriggerVoice: boolean
  setShouldTriggerVoice: (trigger: boolean) => void
}

const AppContext = createContext<AppContextType | undefined>(undefined)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [connections, setConnections] = useState<HAConnection[]>([])
  const [activeConnection, setActiveConnection] = useState<HAConnection | null>(null)
  const [rooms, setRooms] = useState<Room[]>([])
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [uiState, setUIState] = useState<UIState>({
    language: navigator.language || 'nl-BE',
    labels: {},
    placeholders: {},
    messages: {},
  })
  const [entityStates, setEntityStates] = useState<Record<string, any>>({})
  const [haWebSocket, setHaWebSocket] = useState<HAWebSocket | null>(null)
  const [haAreas, setHaAreas] = useState<any[]>([])
  const [haDevices, setHaDevices] = useState<any[]>([])
  const [haEntitiesRegistry, setHaEntitiesRegistry] = useState<any[]>([])
  const [activeSuggestion, setActiveSuggestion] = useState<Suggestion | null>(null)
  const [shouldTriggerVoice, setShouldTriggerVoice] = useState(false)

  // Auth lifecycle
  useEffect(() => {
    let mounted = true
    const loadUser = async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (!mounted) return
        setUser(data?.session?.user || null)
        if (data?.session?.provider_token) {
          syncGoogleTokens(data.session).catch(() => {})
        }
      } catch (e) {
        console.error('Failed to load session:', e)
        if (mounted) setUser(null)
      } finally {
        if (mounted) setLoading(false)
      }
    }

    loadUser()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event: string, session: any) => {
      if (!mounted) return
      setUser(session?.user || null)

      if (event === 'SIGNED_OUT' || !session?.user) {
        // Full teardown to prevent cross-user state/token leakage on shared devices
        setConnections([])
        setActiveConnection(null)
        setRooms([])
        setChatHistory([])
        setEntityStates({})
        setHaAreas([])
        setHaDevices([])
        setHaEntitiesRegistry([])
        setActiveSuggestion(null)
        Preferences.remove({ key: 'ButlerWidget.ha_url' }).catch(() => {})
        Preferences.remove({ key: 'ButlerWidget.ha_token' }).catch(() => {})
      } else if (session?.provider_token) {
        syncGoogleTokens(session).catch(() => {})
      }
    })

    return () => {
      mounted = false
      subscription?.unsubscribe()
    }
  }, [])

  // Load user's HA connections
  useEffect(() => {
    if (!user?.id) {
      setConnections([])
      return
    }

    let cancelled = false
    const loadConnections = async () => {
      const { data, error } = await supabase
        .from('ha_connections')
        .select('*')
        .eq('user_id', user.id)

      if (cancelled) return
      if (error) {
        console.error('❌ Failed to load connections:', error)
        return
      }
      setConnections(data || [])
    }

    loadConnections()
    return () => { cancelled = true }
  }, [user?.id])

  const activeConnectionId = activeConnection?.id || null
  const activeApiUrl = activeConnection?.api_url || ''
  const activeApiToken = activeConnection?.api_token || (activeConnection as any)?.token || ''

  // Active connection lifecycle: cache hydration, REST states, Rooms, and WebSocket
  useEffect(() => {
    if (!activeConnectionId) {
      setRooms([])
      setEntityStates({})
      setHaWebSocket(null)
      setHaAreas([])
      setHaDevices([])
      setHaEntitiesRegistry([])
      setActiveSuggestion(null)
      return
    }

    let isCancelled = false
    let ws: HAWebSocket | null = null
    let syncTimer: ReturnType<typeof setTimeout> | null = null

    // Sync HA credentials to native widget SharedPreferences
    const syncWidgetCredentials = async () => {
      try {
        await Preferences.set({ key: 'ButlerWidget.ha_url', value: activeApiUrl })
        await Preferences.set({ key: 'ButlerWidget.ha_token', value: sanitizeHAToken(activeApiToken) })
      } catch {
        // Safe to ignore in web mode
      }
    }
    syncWidgetCredentials()

    // 0. Instant hydration from connection-scoped local cache
    try {
      const cachedStatesRaw = localStorage.getItem(`ha_entity_states_${activeConnectionId}`)
      if (cachedStatesRaw) {
        const parsed = JSON.parse(cachedStatesRaw)
        if (parsed && typeof parsed === 'object') {
          setEntityStates(parsed)
        }
      } else {
        const cachedTilesRaw = localStorage.getItem(`dashboard_tiles_${activeConnectionId}`)
        if (cachedTilesRaw) {
          const tiles = JSON.parse(cachedTilesRaw)
          const initialObj: Record<string, any> = {}
          if (Array.isArray(tiles)) {
            tiles.forEach((t: any) => {
              if (Array.isArray(t.deviceGroups)) {
                t.deviceGroups.forEach((g: any) => {
                  (g.entities || []).forEach((d: any) => {
                    const eid = d.entityId || d.entity_id
                    if (eid) initialObj[eid] = { entity_id: eid, state: 'unknown', attributes: { friendly_name: d.name } }
                  })
                })
              } else if (Array.isArray(t.devices)) {
                t.devices.forEach((d: any) => {
                  const eid = d.entityId || d.entity_id
                  if (eid) initialObj[eid] = { entity_id: eid, state: d.state || 'unknown', attributes: { friendly_name: d.name } }
                })
              }
            })
          }
          if (Object.keys(initialObj).length > 0) {
            setEntityStates(initialObj)
          }
        }
      }
    } catch { }

    // 1. Fresh REST states fetch — fresh states MUST override stale cache!
    const fetchStatesViaRest = async () => {
      if (!activeApiUrl || !activeApiToken) return
      try {
        const res = await fetchWithTimeout(buildHAUrl('/api/states', activeApiUrl), {
          headers: {
            Authorization: `Bearer ${sanitizeHAToken(activeApiToken)}`,
            'Content-Type': 'application/json'
          }
        }, 15000)
        if (isCancelled || !res.ok) return
        const states = await res.json()
        if (isCancelled || !Array.isArray(states) || states.length === 0) return

        const statesObj: Record<string, any> = {}
        states.forEach((s: any) => {
          if (s?.entity_id) statesObj[s.entity_id] = s
        })
        // Fresh states override old cache entries
        setEntityStates(prev => ({ ...prev, ...statesObj }))
        try {
          localStorage.setItem(`ha_entity_states_${activeConnectionId}`, JSON.stringify(statesObj))
        } catch { }
      } catch { }
    }
    fetchStatesViaRest()

    // 2. Load Supabase rooms
    const loadRooms = async () => {
      const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .eq('connection_id', activeConnectionId)

      if (isCancelled) return
      if (error) {
        console.error('❌ Failed to load rooms:', error)
        return
      }
      setRooms(data || [])
    }
    loadRooms()

    // 3. Initialize WebSocket (with strict cancellation guard against React StrictMode / fast switches)
    const initWebSocket = async () => {
      const { logger } = await import('../utils/logger')
      if (isCancelled) return

      let stateQueue: Record<string, any> = {}
      let isFlushing = false

      const flushStateQueue = async () => {
        if (isCancelled || isFlushing) return
        const entries = Object.entries(stateQueue)
        if (entries.length === 0) return

        isFlushing = true
        stateQueue = {}

        // Send in controlled chunks to avoid startup edge-function storms
        const chunkSize = 150
        try {
          for (let i = 0; i < entries.length; i += chunkSize) {
            if (isCancelled) break
            const chunk = entries.slice(i, i + chunkSize).map(([entity_id, state]) => ({
              entity_id,
              state: state?.state,
              attributes: state?.attributes
            }))
            const { error } = await supabase.functions.invoke('mcp-librarian/sync-states', {
              body: {
                connection_id: activeConnectionId,
                states: chunk
              }
            })
            if (error) console.warn('[StateSync] Sync Error:', error.message)
          }
        } catch (e) {
          console.warn('[StateSync] Failed to sync states:', e)
        } finally {
          isFlushing = false
        }
      }

      const queueStateUpdate = (entityId: string, newState: any) => {
        if (isCancelled) return
        stateQueue[entityId] = newState
        if (!syncTimer) {
          syncTimer = setTimeout(() => {
            syncTimer = null
            flushStateQueue()
          }, 3000)
        }
      }

      const fetchHAData = async () => {
        if (isCancelled || !ws) return
        try {
          logger.info('🔄 Fetching HA Data (States & Registries)...')
          const [statesRes, areasRes, devicesRes, entitiesRes] = await Promise.all([
            ws.sendMessage({ type: 'get_states' }),
            ws.sendMessage({ type: 'config/area_registry/list' }),
            ws.sendMessage({ type: 'config/device_registry/list' }),
            ws.sendMessage({ type: 'config/entity_registry/list' })
          ])

          if (isCancelled) return

          if (statesRes.success && Array.isArray(statesRes.result)) {
            const statesObj: Record<string, any> = {}
            statesRes.result.forEach((state: any) => {
              if (state?.entity_id) statesObj[state.entity_id] = state
            })
            setEntityStates(statesObj)
            try {
              localStorage.setItem(`ha_entity_states_${activeConnectionId}`, JSON.stringify(statesObj))
            } catch { }
            logger.info(`✅ Loaded States via WS: ${statesRes.result.length}`)
          }

          if (areasRes.success && Array.isArray(areasRes.result)) {
            setHaAreas(areasRes.result)
          }
          if (devicesRes.success && Array.isArray(devicesRes.result)) {
            setHaDevices(devicesRes.result)
          }
          if (entitiesRes.success && Array.isArray(entitiesRes.result)) {
            setHaEntitiesRegistry(entitiesRes.result)
          }
        } catch (err: any) {
          if (!isCancelled) {
            logger.error('❌ Error fetching HA data:', { message: err?.message || String(err) })
          }
        }
      }

      const createdWs = new HAWebSocket(
        activeApiUrl,
        activeApiToken,
        (entityId, newState) => {
          if (isCancelled) return
          setEntityStates(prev => ({
            ...prev,
            [entityId]: newState
          }))
          queueStateUpdate(entityId, newState)
        },
        fetchHAData
      )

      if (isCancelled) {
        createdWs.close()
        return
      }

      ws = createdWs
      setHaWebSocket(createdWs)

      createdWs.connect()
        .then(() => {
          if (!isCancelled) logger.info('✅ AppContext WS Connected')
        })
        .catch(err => {
          if (!isCancelled) console.warn('⚠️ AppContext WS initial connect error (REST fallback active):', err)
        })
    }

    initWebSocket()

    return () => {
      isCancelled = true
      if (syncTimer) {
        clearTimeout(syncTimer)
        syncTimer = null
      }
      if (ws) {
        ws.close()
        ws = null
      }
      setHaWebSocket(null)
    }
  }, [activeConnectionId, activeApiUrl, activeApiToken])

  // Load connection-specific Chat History
  useEffect(() => {
    if (!activeConnectionId) {
      setChatHistory([])
      return
    }

    let cancelled = false
    const loadHistory = async () => {
      const { data, error } = await supabase
        .from('chat_history')
        .select('*')
        .eq('connection_id', activeConnectionId)
        .order('created_at', { ascending: false })
        .limit(50)

      if (cancelled) return
      if (error) {
        console.error('❌ Error loading chat history:', error)
        return
      }

      if (Array.isArray(data)) {
        const mapped: ChatMessage[] = [...data].reverse().map((d: any) => {
          let aiText = ''
          if (typeof d.ai_response === 'string') {
            aiText = d.ai_response
          } else if (d.ai_response && typeof d.ai_response.text === 'string') {
            aiText = d.ai_response.text
          } else if (d.ai_response) {
            aiText = JSON.stringify(d.ai_response)
          }

          return {
            id: d.id,
            connection_id: d.connection_id,
            user_message: d.user_message,
            ai_response: aiText,
            language: d.language || d.metadata?.language || 'nl',
            actions_taken: d.actions_taken || [],
            scheduled_actions: d.scheduled_actions || [],
            created_at: d.created_at
          }
        })
        setChatHistory(mapped)
      }
    }

    loadHistory()
    return () => { cancelled = true }
  }, [activeConnectionId])

  const addConnection = useCallback((conn: HAConnection) => {
    setConnections(prev => [...prev, conn])
    setActiveConnection(conn)
  }, [])

  const deleteConnection = useCallback(async (id: string) => {
    await clearPushTokenForConnection(id)
    const { error } = await supabase.from('ha_connections').delete().eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    try {
      localStorage.removeItem(`ha_entity_states_${id}`)
      localStorage.removeItem(`dashboard_tiles_${id}`)
      localStorage.removeItem(`ha_topology_${id}`)
    } catch { }
    setConnections(prev => prev.filter(c => c.id !== id))
    setActiveConnection(prev => (prev?.id === id ? null : prev))
  }, [])

  const addRoom = useCallback((room: Room) => {
    setRooms(prev => [...prev, room])
  }, [])

  const deleteRoom = useCallback(async (id: string) => {
    const { error } = await supabase.from('rooms').delete().eq('id', id)
    if (error) throw new Error(error.message)
    setRooms(prev => prev.filter(r => r.id !== id))
  }, [])

  const updateRoom = useCallback(async (room: Room) => {
    const { error } = await supabase
      .from('rooms')
      .update({ name: room.name, description: room.description })
      .eq('id', room.id)
    if (error) throw new Error(error.message)
    setRooms(prev => prev.map(r => (r.id === room.id ? room : r)))
  }, [])

  const updateUIState = useCallback((state: Partial<UIState>) => {
    setUIState(prev => ({ ...prev, ...state }))
  }, [])

  const addChatMessage = useCallback((msg: ChatMessage) => {
    setChatHistory(prev => [...prev, msg])
  }, [])

  const contextValue = useMemo<AppContextType>(() => ({
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
  }), [
    user, loading, connections, activeConnection, rooms, chatHistory,
    uiState, entityStates, haWebSocket, haAreas, haDevices, haEntitiesRegistry,
    activeSuggestion, addConnection, deleteConnection, addRoom, deleteRoom,
    updateRoom, updateUIState, addChatMessage, shouldTriggerVoice
  ])

  return (
    <AppContext.Provider value={contextValue}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const context = useContext(AppContext)
  if (!context) {
    throw new Error('useApp must be used within AppProvider')
  }
  return context
}
