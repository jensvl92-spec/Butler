import { normalizeHAUrl, sanitizeHAToken } from './home-assistant'

export type HAEventType = 'state_changed' | 'auth_required' | 'auth_ok' | 'auth_invalid' | 'result' | 'pong'

export interface HAEvent {
    type: HAEventType
    event?: {
        event_type: string
        data: {
            entity_id: string
            new_state: any
            old_state: any
        }
        origin: string
        time_fired: string
    }
    id?: number
    result?: any
    success?: boolean
    error?: {
        code: string
        message: string
    }
}

interface QueuedMessage {
    id: number
    serialized: string
}

export class HAWebSocket {
    private ws: WebSocket | null = null
    private url: string
    private token: string
    private idCounter = 1
    // Store resolve/reject for pending commands
    private pendingRequests = new Map<number, { resolve: (res: any) => void, reject: (err: any) => void }>()
    private onStateChange: (entityId: string, newState: any) => void
    private onReady?: () => void
    private connectionPromise: Promise<void> | null = null
    private authenticated = false

    // Message Queue for buffering commands only during active auth handshake (evicted on timeout/close!)
    private messageQueue: QueuedMessage[] = []

    // Auto-reconnect & heartbeat properties
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null
    private reconnectAttempts = 0
    private maxReconnectAttempts = 12
    private isClosedExplicitly = false

    // Generic Event Subscriptions (ID -> { eventType, callback })
    private eventSubscriptions = new Map<number, { eventType: string; callback: (event: any) => void }>()

    // Network/visibility recovery handlers
    private boundOnlineHandler: () => void
    private boundVisibilityHandler: () => void

    constructor(url: string, token: string, onStateChange: (id: string, state: any) => void, onReady?: () => void) {
        const cleanBase = normalizeHAUrl(url || '')
        let wsUrl = cleanBase.replace(/^http(s?):\/\//i, 'ws$1://')
        if (!/^wss?:\/\//i.test(wsUrl)) {
            wsUrl = `ws://${wsUrl}`
        }
        wsUrl += '/api/websocket'

        this.url = wsUrl
        this.token = sanitizeHAToken(token)
        this.onStateChange = onStateChange
        this.onReady = onReady

        this.boundOnlineHandler = () => {
            if (!this.isClosedExplicitly && !this.isConnected()) {
                this.reconnectAttempts = 0
                this.connect().catch(() => {})
            }
        }
        this.boundVisibilityHandler = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !this.isClosedExplicitly && !this.isConnected()) {
                this.reconnectAttempts = 0
                this.connect().catch(() => {})
            }
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('online', this.boundOnlineHandler)
            document.addEventListener('visibilitychange', this.boundVisibilityHandler)
        }
    }

    connect(): Promise<void> {
        if (this.isConnected()) return Promise.resolve()
        if (this.connectionPromise) return this.connectionPromise

        this.connectionPromise = new Promise((resolve, reject) => {
            let settled = false
            const safeResolve = () => {
                if (!settled) {
                    settled = true
                    resolve()
                }
            }
            const safeReject = (err: any) => {
                if (!settled) {
                    settled = true
                    this.connectionPromise = null
                    reject(err)
                }
            }

            console.log('🔌 Connecting to HA WebSocket:', this.url)
            this.isClosedExplicitly = false

            try {
                this.ws = new WebSocket(this.url)
            } catch (e) {
                console.error('Failed to create WebSocket', e)
                safeReject(e)
                this.scheduleReconnect()
                return
            }

            this.ws.onopen = () => {
                console.log('🔌 WS Open')
                this.reconnectAttempts = 0
            }

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data)
                    this.handleMessage(message, safeResolve, safeReject)
                } catch (e) {
                    console.error('Error parsing WS message', e)
                }
            }

            this.ws.onerror = (error) => {
                console.error('🔌 WS Error:', error)
                if (!this.authenticated) safeReject(error)
            }

            this.ws.onclose = () => {
                console.log('🔌 WS Closed')
                const wasAuthenticated = this.authenticated
                this.authenticated = false
                this.connectionPromise = null
                this.stopHeartbeat()

                // Reject all pending requests AND evict queued commands so stale commands never ghost-execute on reconnect!
                this.pendingRequests.forEach((p) => p.reject(new Error('WebSocket closed')))
                this.pendingRequests.clear()
                this.messageQueue = []

                if (!wasAuthenticated) {
                    safeReject(new Error('WebSocket closed before authentication'))
                }

                if (!this.isClosedExplicitly) {
                    this.scheduleReconnect()
                }
            }
        })

        return this.connectionPromise
    }

    private startHeartbeat() {
        this.stopHeartbeat()
        this.heartbeatTimer = setInterval(() => {
            if (!this.isConnected()) {
                this.stopHeartbeat()
                return
            }
            this.sendMessage({ type: 'ping' }, 6000).catch(() => {
                console.warn('🔌 WS Heartbeat timeout — forcing reconnect')
                try {
                    this.ws?.close()
                } catch { }
            })
        }, 30000)
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
    }

    private scheduleReconnect() {
        if (this.isClosedExplicitly) return
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn('🔌 Max reconnect attempts reached (will retry on network/app resume)')
            return
        }

        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
        console.log(`🔌 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`)

        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++
            this.connect().catch(() => {})
        }, delay)
    }

    private handleMessage(message: any, resolve: () => void, reject: (err: any) => void) {
        if (message.type === 'auth_required') {
            this.sendAuth()
            return
        }

        if (message.type === 'auth_ok') {
            this.authenticated = true
            this.startHeartbeat()
            import('./logger').then(({ logger }) => logger.info('✅ Auth OK - Re-subscribing & Refreshing State'))
            this.subscribeStateChanges()
            this.resubscribeGenericEvents()
            this.flushQueue()
            if (this.onReady) this.onReady()
            resolve()
            return
        }

        if (message.type === 'auth_invalid') {
            console.error('Auth Invalid:', message.message)
            // Set explicit close flag BEFORE calling ws.close() to prevent reconnect race
            this.isClosedExplicitly = true
            this.ws?.close()
            reject(new Error(message.message || 'Authentication invalid'))
            return
        }

        if (message.type === 'pong' && message.id && this.pendingRequests.has(message.id)) {
            const req = this.pendingRequests.get(message.id)!
            this.pendingRequests.delete(message.id)
            req.resolve(message)
            return
        }

        // Command Results
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve: reqResolve, reject: reqReject } = this.pendingRequests.get(message.id)!
            this.pendingRequests.delete(message.id)

            if (message.success === false) {
                reqReject(new Error(message.error?.message || 'Command failed'))
            } else {
                reqResolve(message)
            }
            return
        }

        // Events
        if (message.type === 'event' && message.event) {
            if (message.id && this.eventSubscriptions.has(message.id)) {
                this.eventSubscriptions.get(message.id)!.callback(message.event)
            }

            if (message.event.event_type === 'state_changed') {
                const { entity_id, new_state } = message.event.data
                this.onStateChange(entity_id, new_state)
            }
        }
    }

    private sendAuth() {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'auth',
                access_token: this.token
            }))
        }
    }

    private subscribeStateChanges() {
        import('./logger').then(({ logger }) => {
            logger.info('🔌 Subscribing to state_changed events')
            this.sendMessage({
                type: 'subscribe_events',
                event_type: 'state_changed'
            }).then(() => logger.info('✅ Subscribed to state_changed'))
                .catch(err => logger.error('❌ Subscription Failed', err))
        })
    }

    private resubscribeGenericEvents() {
        const existing = Array.from(this.eventSubscriptions.values())
        this.eventSubscriptions.clear()
        existing.forEach(({ eventType, callback }) => {
            this.subscribeEvents(eventType, callback).catch(() => {})
        })
    }

    private flushQueue() {
        while (this.messageQueue.length > 0) {
            const item = this.messageQueue.shift()
            if (item && this.pendingRequests.has(item.id) && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(item.serialized)
            }
        }
    }

    public sendMessage(payload: any, timeoutMs = 10000): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.idCounter++

            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id)
                    // Evict from messageQueue so timed-out command NEVER ghost-executes later!
                    this.messageQueue = this.messageQueue.filter(m => m.id !== id)
                    console.warn(`⏱️ WebSocket timeout after ${timeoutMs}ms for message ID ${id}`)
                    reject(new Error(`WebSocket timeout after ${timeoutMs}ms`))
                }
            }, timeoutMs)

            this.pendingRequests.set(id, {
                resolve: (res) => { clearTimeout(timeout); resolve(res) },
                reject: (err) => { clearTimeout(timeout); reject(err) }
            })

            const serialized = JSON.stringify({
                id,
                ...payload
            })

            if (this.isConnected()) {
                this.ws!.send(serialized)
            } else {
                console.warn(`⚠️ WS Not Ready (Auth: ${this.authenticated}, State: ${this.ws?.readyState}). Buffering message ID ${id}`)
                this.messageQueue.push({ id, serialized })

                if (!this.isClosedExplicitly && (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING)) {
                    this.connect().catch(() => {})
                }
            }
        })
    }

    public isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN && this.authenticated
    }

    public getStatus(): string {
        return `Authenticated: ${this.authenticated}, ReadyState: ${this.ws?.readyState}, Queue: ${this.messageQueue.length}`
    }

    public async subscribeEvents(eventType: string, callback: (event: any) => void): Promise<() => void> {
        try {
            const result = await this.sendMessage({
                type: 'subscribe_events',
                event_type: eventType
            })

            const subscriptionId = result.id
            this.eventSubscriptions.set(subscriptionId, { eventType, callback })

            return () => {
                if (this.eventSubscriptions.has(subscriptionId)) {
                    this.eventSubscriptions.delete(subscriptionId)
                    if (this.isConnected()) {
                        this.sendMessage({
                            type: 'unsubscribe_events',
                            subscription: subscriptionId
                        }, 3000).catch(() => {})
                    }
                }
            }
        } catch (e) {
            console.error(`❌ Failed to subscribe to ${eventType}`, e)
            throw e
        }
    }

    public close() {
        this.isClosedExplicitly = true
        this.stopHeartbeat()
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        this.messageQueue = []
        this.pendingRequests.forEach((p) => p.reject(new Error('WebSocket closed explicitly')))
        this.pendingRequests.clear()
        this.eventSubscriptions.clear()
        if (typeof window !== 'undefined') {
            window.removeEventListener('online', this.boundOnlineHandler)
            document.removeEventListener('visibilitychange', this.boundVisibilityHandler)
        }
        try {
            this.ws?.close()
        } catch { }
        this.ws = null
        this.authenticated = false
        this.connectionPromise = null
    }
}
