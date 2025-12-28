import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { HAConnection, Room, UIState, ChatMessage } from '../types'
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
  // Keep track of WS client to close it on change
  const [haWebSocket, setHaWebSocket] = useState<HAWebSocket | null>(null)

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
    // Clean up previous connection if any (though effect cleanup handles it)
    const ws = new HAWebSocket(activeConnection.api_url, activeConnection.api_token, (entityId, newState) => {
      setEntityStates(prev => ({
        ...prev,
        [entityId]: newState
      }))
    })

    ws.connect()
      .then(async () => {
        console.log('✅ AppContext WS Connected')
        // Only try to fetch initial states via WebSocket to avoid CORS issues with REST API
        try {
          console.log('🔄 Fetching initial states via WebSocket...')
          const response = await ws.sendMessage({ type: 'get_states' })

          if (response.success && Array.isArray(response.result)) {
            // Convert array to keyed object
            const statesObj: Record<string, any> = {}
            response.result.forEach((state: any) => {
              statesObj[state.entity_id] = state
            })
            setEntityStates(statesObj)
            console.log('✅ Loaded initial states via WS:', response.result.length, 'entities')
          } else {
            console.warn('⚠️ Failed to get states via WS:', response)
          }
        } catch (err) {
          console.error('❌ Error fetching initial states via WS:', err)
        }
      })
      .catch(err => console.error('❌ AppContext WS Error', err))

    setHaWebSocket(ws)

    return () => {
      ws.close()
    }
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
