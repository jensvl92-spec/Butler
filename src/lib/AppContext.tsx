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
  haSyncSource: 'none' | 'cache' | 'rest' | 'websocket'
  refreshHAFromServer: () => Promise<{
    states: Record<string, any>
    areas: any[]
    devices: any[]
    entities: any[]
    source: 'rest' | 'websocket' | 'cache'
    error?: string
  }>

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
  const [haSyncSource, setHaSyncSource] = useState<'none' | 'cache' | 'rest' | 'websocket'>('none')
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
        setHaSyncSource('none')
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

  // Active connection lifecycle: cache hydration, REST states + rich topology fallback, Rooms, and WebSocket
  useEffect(() => {
    if (!activeConnectionId) {
      setRooms([])
      setEntityStates({})
      setHaWebSocket(null)
      setHaAreas([])
      setHaDevices([])
      setHaEntitiesRegistry([])
      setHaSyncSource('none')
      setActiveSuggestion(null)
      return
    }

    let isCancelled = false
    let ws: HAWebSocket | null = null
    let syncTimer: ReturnType<typeof setTimeout> | null = null
    let restTopologyTimer: ReturnType<typeof setTimeout> | null = null
    let initialSyncTimer: ReturnType<typeof setTimeout> | null = null
    let wsRegistriesLoaded = false
    let initialSnapshotSynced = false

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

    // Helper: schedule a gentle chunked initial snapshot sync so idle/powered-off appliances
    // (like washers/dryers) are always known to proactive backend workers
    const scheduleInitialStateSnapshotSync = (statesObj: Record<string, any>) => {
      if (initialSnapshotSynced || isCancelled) return
      const entries = Object.entries(statesObj)
      if (entries.length === 0) return
      initialSnapshotSynced = true

      initialSyncTimer = setTimeout(async () => {
        if (isCancelled) return
        const chunkSize = 150
        try {
          for (let i = 0; i < entries.length; i += chunkSize) {
            if (isCancelled) break
            const chunk = entries.slice(i, i + chunkSize).map(([entity_id, state]) => ({
              entity_id,
              state: state?.state,
              attributes: state?.attributes
            }))
            await supabase.functions.invoke('mcp-librarian/sync-states', {
              body: {
                connection_id: activeConnectionId,
                states: chunk
              }
            }).catch(() => {})
          }
        } catch { }
      }, 5000)
    }

    // Helper: persist enriched topology cache
    const persistTopologyCache = (loadedAreas: any[], loadedDevices: any[], loadedEntities: any[]) => {
      if (loadedAreas.length === 0 && loadedEntities.length === 0) return
      try {
        const devAreaMap = new Map<string, string>()
        loadedDevices.forEach((d: any) => {
          if (d?.id && d?.area_id) devAreaMap.set(d.id, d.area_id)
        })
        const areaEntityMap = new Map<string, string[]>()
        loadedAreas.forEach((a: any) => {
          if (a?.area_id) areaEntityMap.set(a.area_id, [])
        })
        const orphans: string[] = []
        loadedEntities.forEach((e: any) => {
          if (!e?.entity_id || e.hidden_by || e.disabled_by) return
          const aid = e.area_id || (e.device_id ? devAreaMap.get(e.device_id) : undefined)
          if (aid && areaEntityMap.has(aid)) {
            areaEntityMap.get(aid)!.push(e.entity_id)
          } else {
            orphans.push(e.entity_id)
          }
        })
        const topologyObj = {
          floors: [],
          areas: loadedAreas.map((a: any) => ({
            id: a.area_id,
            name: a.name,
            entities: areaEntityMap.get(a.area_id) || []
          })),
          orphans
        }
        const serialized = JSON.stringify(topologyObj)
        localStorage.setItem(`ha_topology_${activeConnectionId}`, serialized)
        localStorage.setItem('ha_topology_latest', serialized)
        localStorage.setItem(`ha_registries_${activeConnectionId}`, JSON.stringify({
          areas: loadedAreas,
          devices: loadedDevices,
          entities: loadedEntities,
          updatedAt: Date.now()
        }))
      } catch { }
    }

    // 0. Instant hydration from connection-scoped local cache (states + registries for instant grouped layout!)
    try {
      const cachedRegRaw = localStorage.getItem(`ha_registries_${activeConnectionId}`)
      if (cachedRegRaw) {
        const parsedReg = JSON.parse(cachedRegRaw)
        if (parsedReg && Array.isArray(parsedReg.entities) && parsedReg.entities.length > 0) {
          if (Array.isArray(parsedReg.areas)) setHaAreas(parsedReg.areas)
          if (Array.isArray(parsedReg.devices)) setHaDevices(parsedReg.devices)
          setHaEntitiesRegistry(parsedReg.entities)
        }
      }

      const cachedStatesRaw = localStorage.getItem(`ha_entity_states_${activeConnectionId}`)
      if (cachedStatesRaw) {
        const parsed = JSON.parse(cachedStatesRaw)
        if (parsed && typeof parsed === 'object') {
          setEntityStates(parsed)
          setHaSyncSource('cache')
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
            setHaSyncSource('cache')
          }
        }
      }
    } catch { }

    // Detect Android/WebView mixed-content scenario: https://localhost page connecting to local Wi-Fi http:// HA!
    // CapacitorHttp bypasses mixed-content for REST fetch(), whereas Chromium blocks ws:// from an https:// origin.
    const isMixedContentWs =
      typeof window !== 'undefined' &&
      window.location.protocol === 'https:' &&
      /^http:\/\//i.test((activeApiUrl || '').trim())

    let restTopologyInFlight = false
    let restPollTimer: ReturnType<typeof setInterval> | null = null

    // 1. Fresh REST states fetch — fresh states MUST override stale cache!
    const fetchStatesViaRest = async () => {
      if (!activeApiUrl || !activeApiToken) return
      try {
        const res = await fetchWithTimeout(buildHAUrl('/api/states', activeApiUrl), {
          headers: {
            Authorization: `Bearer ${sanitizeHAToken(activeApiToken)}`,
            'Content-Type': 'application/json'
          }
        }, 18000)
        if (isCancelled || !res.ok) return
        const states = await res.json()
        if (isCancelled || !Array.isArray(states) || states.length === 0) return

        const statesObj: Record<string, any> = {}
        states.forEach((s: any) => {
          if (s?.entity_id) statesObj[s.entity_id] = s
        })
        setEntityStates(prev => ({ ...prev, ...statesObj }))
        setHaSyncSource(prev => (prev === 'websocket' ? 'websocket' : 'rest'))
        try {
          localStorage.setItem(`ha_entity_states_${activeConnectionId}`, JSON.stringify(statesObj))
        } catch { }
        scheduleInitialStateSnapshotSync(statesObj)
      } catch { }
    }
    fetchStatesViaRest()

    // 1b. Automatic REST /api/template rich topology fallback
    // Runs IMMEDIATELY (0ms) on local Wi-Fi http:// (where ws:// is blocked by HTTPS WebView),
    // or after 2.5s if WebSocket hasn't delivered registries yet (e.g. Tailscale slow handshake).
    const runRestTopologyFallback = async () => {
      if (isCancelled || wsRegistriesLoaded || restTopologyInFlight || !activeApiUrl || !activeApiToken) return
      restTopologyInFlight = true
      try {
        const { fetchRichHATopology } = await import('../utils/ha-api')
        const rich = await fetchRichHATopology(activeApiUrl, activeApiToken, activeConnectionId)
        if (isCancelled || wsRegistriesLoaded) return
        if (rich.areas.length > 0) setHaAreas(rich.areas)
        if (rich.devices.length > 0) setHaDevices(rich.devices)
        if (rich.entities.length > 0) setHaEntitiesRegistry(rich.entities)
        setHaSyncSource(prev => (prev === 'websocket' ? 'websocket' : 'rest'))
      } catch (err: any) {
        if (!isCancelled) {
          console.warn('⚠️ REST rich topology fallback skipped:', err?.message || err)
        }
      } finally {
        restTopologyInFlight = false
      }
    }

    if (isMixedContentWs) {
      // Local Wi-Fi HTTP inside HTTPS WebView -> run REST rich topology IMMEDIATELY & poll states gently!
      runRestTopologyFallback()
      restPollTimer = setInterval(() => {
        if (!isCancelled && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
          fetchStatesViaRest()
        }
      }, 10000)
    } else {
      restTopologyTimer = setTimeout(() => {
        if (!wsRegistriesLoaded && !isCancelled) {
          runRestTopologyFallback()
        }
      }, 2500)
    }

    const handleNetworkOrResume = () => {
      if (isCancelled) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      fetchStatesViaRest()
      if (!wsRegistriesLoaded) {
        runRestTopologyFallback()
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleNetworkOrResume)
      document.addEventListener('visibilitychange', handleNetworkOrResume)
    }

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

    // 3. Initialize WebSocket (skipped cleanly when HTTPS WebView -> http:// Wi-Fi mixed-content would block ws://)
    const initWebSocket = async () => {
      if (isMixedContentWs) {
        console.log('ℹ️ Local HTTP HA on HTTPS WebView detected — using CapacitorHttp REST mode + live polling')
        return
      }
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
          logger.info('🔄 Fetching HA Data (States & Registries, 25s timeout)...')
          const [statesSettled, areasSettled, devicesSettled, entitiesSettled] = await Promise.allSettled([
            ws.sendMessage({ type: 'get_states' }, 25000),
            ws.sendMessage({ type: 'config/area_registry/list' }, 25000),
            ws.sendMessage({ type: 'config/device_registry/list' }, 25000),
            ws.sendMessage({ type: 'config/entity_registry/list' }, 25000)
          ])

          if (isCancelled) return

          const statesRes = statesSettled.status === 'fulfilled' ? statesSettled.value : null
          const areasRes = areasSettled.status === 'fulfilled' ? areasSettled.value : null
          const devicesRes = devicesSettled.status === 'fulfilled' ? devicesSettled.value : null
          const entitiesRes = entitiesSettled.status === 'fulfilled' ? entitiesSettled.value : null

          if (statesRes?.success && Array.isArray(statesRes.result)) {
            const statesObj: Record<string, any> = {}
            statesRes.result.forEach((state: any) => {
              if (state?.entity_id) statesObj[state.entity_id] = state
            })
            setEntityStates(statesObj)
            setHaSyncSource('websocket')
            try {
              localStorage.setItem(`ha_entity_states_${activeConnectionId}`, JSON.stringify(statesObj))
            } catch { }
            logger.info(`✅ Loaded States via WS: ${statesRes.result.length}`)
            scheduleInitialStateSnapshotSync(statesObj)
          }

          const loadedAreas = areasRes?.success && Array.isArray(areasRes.result) ? areasRes.result : []
          const rawDevices = devicesRes?.success && Array.isArray(devicesRes.result) ? devicesRes.result : []
          const loadedDevices = rawDevices.map((d: any) => {
            const identPlatform = Array.isArray(d?.identifiers) && Array.isArray(d.identifiers[0])
              ? d.identifiers[0][0]
              : undefined
            return {
              ...d,
              platform: d?.platform || identPlatform || undefined
            }
          })
          const loadedEntities = entitiesRes?.success && Array.isArray(entitiesRes.result) ? entitiesRes.result : []

          if (loadedAreas.length > 0) setHaAreas(loadedAreas)
          if (loadedDevices.length > 0) setHaDevices(loadedDevices)
          if (loadedEntities.length > 0) {
            wsRegistriesLoaded = true
            setHaEntitiesRegistry(loadedEntities)
            setHaSyncSource('websocket')
            logger.info(`✅ Loaded Registries via WS: ${loadedAreas.length} areas, ${loadedDevices.length} devices, ${loadedEntities.length} entities`)
          } else {
            // WS entity_registry failed or timed out -> trigger REST rich topology fallback immediately!
            logger.warn('⚠️ WS entity_registry empty/failed — invoking REST rich topology fallback')
            runRestTopologyFallback()
          }

          persistTopologyCache(loadedAreas, loadedDevices, loadedEntities)
        } catch (err: any) {
          if (!isCancelled) {
            logger.error('❌ Error fetching HA data via WS (triggering REST fallback):', { message: err?.message || String(err) })
            runRestTopologyFallback()
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
          if (!isCancelled) {
            console.warn('⚠️ AppContext WS initial connect error (REST fallback active):', err)
            runRestTopologyFallback()
          }
        })
    }

    initWebSocket()

    return () => {
      isCancelled = true
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleNetworkOrResume)
        document.removeEventListener('visibilitychange', handleNetworkOrResume)
      }
      if (syncTimer) {
        clearTimeout(syncTimer)
        syncTimer = null
      }
      if (restTopologyTimer) {
        clearTimeout(restTopologyTimer)
        restTopologyTimer = null
      }
      if (restPollTimer) {
        clearInterval(restPollTimer)
        restPollTimer = null
      }
      if (initialSyncTimer) {
        clearTimeout(initialSyncTimer)
        initialSyncTimer = null
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
      localStorage.removeItem(`ha_registries_${id}`)
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

  const refreshHAFromServer = useCallback(async (): Promise<{
    states: Record<string, any>
    areas: any[]
    devices: any[]
    entities: any[]
    source: 'rest' | 'websocket' | 'cache'
    error?: string
  }> => {
    if (!activeConnectionId || !activeApiUrl || !activeApiToken) {
      return { states: entityStates, areas: haAreas, devices: haDevices, entities: haEntitiesRegistry, source: 'cache', error: 'Geen actieve Home Assistant verbinding.' }
    }

    let nextStates: Record<string, any> = entityStates
    let nextAreas: any[] = haAreas
    let nextDevices: any[] = haDevices
    let nextEntities: any[] = haEntitiesRegistry
    let usedSource: 'rest' | 'websocket' | 'cache' = 'cache'
    let lastErr: string | undefined

    // 1. Prefer live WebSocket if currently connected
    if (haWebSocket && haWebSocket.isConnected()) {
      try {
        const [stRes, arRes, dvRes, enRes] = await Promise.allSettled([
          haWebSocket.sendMessage({ type: 'get_states' }, 15000),
          haWebSocket.sendMessage({ type: 'config/area_registry/list' }, 15000),
          haWebSocket.sendMessage({ type: 'config/device_registry/list' }, 15000),
          haWebSocket.sendMessage({ type: 'config/entity_registry/list' }, 15000)
        ])
        if (stRes.status === 'fulfilled' && stRes.value?.success && Array.isArray(stRes.value.result)) {
          const map: Record<string, any> = {}
          stRes.value.result.forEach((s: any) => { if (s?.entity_id) map[s.entity_id] = s })
          nextStates = map
          setEntityStates(map)
          usedSource = 'websocket'
          try { localStorage.setItem(`ha_entity_states_${activeConnectionId}`, JSON.stringify(map)) } catch { }
        }
        if (arRes.status === 'fulfilled' && arRes.value?.success && Array.isArray(arRes.value.result)) {
          nextAreas = arRes.value.result
          setHaAreas(nextAreas)
        }
        if (dvRes.status === 'fulfilled' && dvRes.value?.success && Array.isArray(dvRes.value.result)) {
          nextDevices = dvRes.value.result.map((d: any) => {
            const identPlatform = Array.isArray(d?.identifiers) && Array.isArray(d.identifiers[0]) ? d.identifiers[0][0] : undefined
            return { ...d, platform: d?.platform || identPlatform || undefined }
          })
          setHaDevices(nextDevices)
        }
        if (enRes.status === 'fulfilled' && enRes.value?.success && Array.isArray(enRes.value.result) && enRes.value.result.length > 0) {
          nextEntities = enRes.value.result
          setHaEntitiesRegistry(nextEntities)
          usedSource = 'websocket'
          setHaSyncSource('websocket')
          try {
            localStorage.setItem(`ha_registries_${activeConnectionId}`, JSON.stringify({
              areas: nextAreas, devices: nextDevices, entities: nextEntities, updatedAt: Date.now()
            }))
          } catch { }
          return { states: nextStates, areas: nextAreas, devices: nextDevices, entities: nextEntities, source: 'websocket' }
        }
      } catch (wsErr: any) {
        lastErr = wsErr?.message || String(wsErr)
      }
    }

    // 2. Always fetch FRESH REST /api/states + parallel REST rich topology (works on both Wi-Fi HTTP & Tailscale HTTPS!)
    const [statesSettled, topoSettled] = await Promise.allSettled([
      fetchWithTimeout(buildHAUrl('/api/states', activeApiUrl), {
        headers: {
          Authorization: `Bearer ${sanitizeHAToken(activeApiToken)}`,
          'Content-Type': 'application/json'
        }
      }, 15000),
      import('../utils/ha-api').then(({ fetchRichHATopology }) =>
        fetchRichHATopology(activeApiUrl, activeApiToken, activeConnectionId)
      )
    ])

    if (statesSettled.status === 'fulfilled' && statesSettled.value.ok) {
      const arr = await statesSettled.value.json().catch(() => null)
      if (Array.isArray(arr) && arr.length > 0) {
        const map: Record<string, any> = {}
        arr.forEach((s: any) => { if (s?.entity_id) map[s.entity_id] = s })
        nextStates = map
        setEntityStates(map)
        usedSource = 'rest'
        setHaSyncSource(prev => (prev === 'websocket' ? 'websocket' : 'rest'))
        try { localStorage.setItem(`ha_entity_states_${activeConnectionId}`, JSON.stringify(map)) } catch { }
      }
    } else {
      lastErr = statesSettled.status === 'rejected'
        ? (statesSettled.reason?.message || 'Netwerkfout bij ophalen statussen')
        : `Home Assistant gaf HTTP ${statesSettled.value.status}`
    }

    if (topoSettled.status === 'fulfilled') {
      const rich = topoSettled.value
      if (rich.areas.length > 0) { nextAreas = rich.areas; setHaAreas(rich.areas) }
      if (rich.devices.length > 0) { nextDevices = rich.devices; setHaDevices(rich.devices) }
      if (rich.entities.length > 0) { nextEntities = rich.entities; setHaEntitiesRegistry(rich.entities) }
      usedSource = 'rest'
      setHaSyncSource(prev => (prev === 'websocket' ? 'websocket' : 'rest'))
    } else if (!lastErr) {
      lastErr = topoSettled.reason?.message || 'Kon apparaat-topologie niet vernieuwen'
    }

    return {
      states: nextStates,
      areas: nextAreas,
      devices: nextDevices,
      entities: nextEntities,
      source: usedSource,
      error: usedSource === 'cache' ? lastErr : undefined
    }
  }, [activeConnectionId, activeApiUrl, activeApiToken, haWebSocket, entityStates, haAreas, haDevices, haEntitiesRegistry])

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
    haSyncSource,
    refreshHAFromServer,
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
    haSyncSource, refreshHAFromServer, activeSuggestion, addConnection, deleteConnection, addRoom, deleteRoom,
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
