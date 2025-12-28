import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { HAConnection, Room, UIState, ChatMessage, Suggestion } from '../types'
import { HAWebSocket } from '../utils/ha-websocket'



interface AppContextType {
  user: any
  loading: boolean
  connections: HAConnection[]
  activeConnection: HAConnection | null
  rooms: Room[]
  chatHistory: ChatMessage[]
  uiState: UIState
  entityStates: Record<string, any> // Store live HA states
  haWebSocket: HAWebSocket | null
  // Registries
  haAreas: any[]
  haDevices: any[]
  haEntitiesRegistry: any[]

  activeSuggestion: Suggestion | null
  setActiveSuggestion: (suggestion: Suggestion | null) => void // Shared setter
  setActiveConnection: (conn: HAConnection | null) => void
  addConnection: (conn: HAConnection) => void
  deleteConnection: (id: string) => void
  addRoom: (room: Room) => void
  deleteRoom: (id: string) => void
  updateRoom: (room: Room) => void
  updateUIState: (state: Partial<UIState>) => void
  addChatMessage: (msg: ChatMessage) => void
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
    language: navigator.language || 'en-US',
    labels: {},
    placeholders: {},
    messages: {},
  })
  const [entityStates, setEntityStates] = useState<Record<string, any>>({})
  // HA Data
  const [haWebSocket, setHaWebSocket] = useState<HAWebSocket | null>(null)
  const [haAreas, setHaAreas] = useState<any[]>([])
  const [haDevices, setHaDevices] = useState<any[]>([])
  const [haEntitiesRegistry, setHaEntitiesRegistry] = useState<any[]>([])

  const [activeSuggestion, setActiveSuggestion] = useState<Suggestion | null>(null)

  useEffect(() => {
    const loadUser = async () => {
      const { data } = await supabase.auth.getSession()
      setUser(data?.session?.user || null)
      setLoading(false)
    }

    loadUser()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null)
    })

    return () => subscription?.unsubscribe()
  }, [])

  useEffect(() => {
    if (!user) return

    const loadConnections = async () => {
      const { data } = await supabase
        .from('ha_connections')
        .select('*')
        .eq('user_id', user.id)

      setConnections(data || [])
    }

    loadConnections()
  }, [user])

  useEffect(() => {
    if (!activeConnection) {
      setRooms([])
      setEntityStates({})
      return
    }

    const loadRooms = async () => {
      const { data } = await supabase
        .from('rooms')
        .select('*')
        .eq('connection_id', activeConnection.id)

      setRooms(data || [])
    }

    loadRooms()

    // 🔌 Initialize WebSocket
    let ws: HAWebSocket | null = null;

    const initWebSocket = async () => {
      const { logger } = await import('../utils/logger'); // Dynamic import for safety

      // Define Fetch Data Logic
      const fetchHAData = async () => {
        if (!ws) return;
        try {
          const { logger } = await import('../utils/logger');
          logger.info('🔄 Fetching HA Data (States & Registries)...')
          const [statesRes, areasRes, devicesRes, entitiesRes] = await Promise.all([
            ws!.sendMessage({ type: 'get_states' }),
            ws!.sendMessage({ type: 'config/area_registry/list' }),
            ws!.sendMessage({ type: 'config/device_registry/list' }),
            ws!.sendMessage({ type: 'config/entity_registry/list' })
          ])

          // 1. States
          if (statesRes.success && Array.isArray(statesRes.result)) {
            const statesObj: Record<string, any> = {}
            statesRes.result.forEach((state: any) => { statesObj[state.entity_id] = state })
            setEntityStates(statesObj)
            logger.info(`✅ Loaded States: ${statesRes.result.length}`)
          } else {
            logger.warn('⚠️ Failed to get states:', statesRes)
          }

          // 2. Registries (Store in State)
          if (areasRes.success) {
            setHaAreas(areasRes.result);
            logger.info(`✅ Loaded Areas: ${areasRes.result.length}`)
          }

          if (devicesRes.success) {
            setHaDevices(devicesRes.result);
            logger.info(`✅ Loaded Devices: ${devicesRes.result.length}`)
          }

          if (entitiesRes.success) {
            setHaEntitiesRegistry(entitiesRes.result);
            logger.info(`✅ Loaded Entities Reg: ${entitiesRes.result.length}`)
          }

          logger.info('✅ HA Metadata Loading Complete')

        } catch (err: any) {
          const { logger } = await import('../utils/logger');
          logger.error('❌ Error fetching HA data:', { message: err.message })
        }
      }

      // Clean up previous connection if any (though effect cleanup handles it)
      // Pass fetchHAData as the onReady callback (4th arg)
      ws = new HAWebSocket(activeConnection.api_url, activeConnection.api_token, (entityId, newState) => {
        setEntityStates(prev => ({
          ...prev,
          [entityId]: newState
        }))
      }, fetchHAData)

      ws.connect()
        .then(async () => {
          const { logger } = await import('../utils/logger');
          logger.info('✅ AppContext WS Connected')
          // fetchHAData is called automatically by onReady
        })
        .catch(err => {
          // For the catch block of connect():
          console.error('❌ AppContext WS Error', err)
        })

      setHaWebSocket(ws)
    }

    initWebSocket();

    return () => {
      if (ws) ws.close()
    }
  }, [activeConnection])

  // Load connection-specific Chat History
  useEffect(() => {
    if (!activeConnection) {
      setChatHistory([])
      return
    }

    const loadHistory = async () => {
      console.log('🔄 Loading Chat History for:', activeConnection.id)
      const { data, error } = await supabase
        .from('chat_history')
        .select('*')
        .eq('connection_id', activeConnection.id)
        .order('created_at', { ascending: false })
        .limit(50)

      if (error) {
        console.error('❌ Error loading chat history:', error)
        return
      }

      if (data) {
        console.log(`✅ Loaded ${data.length} messages.`)
        // Map DB format (json) to UI format (string)
        const mapped: ChatMessage[] = data.reverse().map((d: any) => {
          let aiText = "";
          if (typeof d.ai_response === 'string') {
            aiText = d.ai_response;
          } else if (d.ai_response && d.ai_response.text) {
            aiText = d.ai_response.text;
          } else {
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
          }
        })
        setChatHistory(mapped)
      } else {
        console.warn('⚠️ No chat history found.')
      }
    }

    loadHistory()
  }, [activeConnection])






  const addConnection = (conn: HAConnection) => {
    setConnections([...connections, conn])
  }

  const deleteConnection = async (id: string) => {
    await supabase.from('ha_connections').delete().eq('id', id)
    setConnections(connections.filter((c) => c.id !== id))
    if (activeConnection?.id === id) {
      setActiveConnection(null)
    }
  }

  const addRoom = (room: Room) => {
    setRooms([...rooms, room])
  }

  const deleteRoom = async (id: string) => {
    await supabase.from('rooms').delete().eq('id', id)
    setRooms(rooms.filter((r) => r.id !== id))
  }

  const updateRoom = async (room: Room) => {
    await supabase.from('rooms').update(room).eq('id', room.id)
    setRooms(rooms.map((r) => (r.id === room.id ? room : r)))
  }

  const updateUIState = (state: Partial<UIState>) => {
    setUIState((prev) => ({ ...prev, ...state }))
  }

  const addChatMessage = (msg: ChatMessage) => {
    setChatHistory([...chatHistory, msg])
  }

  return (
    <AppContext.Provider
      value={{
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
      }}
    >
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
