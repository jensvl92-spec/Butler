
export type HAEventType = 'state_changed' | 'auth_required' | 'auth_ok' | 'auth_invalid' | 'result'

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

export class HAWebSocket {
    private ws: WebSocket | null = null
    private url: string
    private token: string
    private idCounter = Date.now()
    // Store resolve/reject for pending commands
    private pendingRequests = new Map<number, { resolve: (res: any) => void, reject: (err: any) => void }>()
    private onStateChange: (entityId: string, newState: any) => void
    private onReady?: () => void
    private connectionPromise: Promise<void> | null = null
    private authenticated = false

    // Message Queue for buffering commands before Auth
    private messageQueue: string[] = []

    // Auto-reconnect properties
    private reconnectTimer: any = null
    private reconnectAttempts = 0
    private maxReconnectAttempts = 5
    private isClosedExplicitly = false

    // Generic Event Subscriptions (ID -> Callback)
    private eventSubscriptions = new Map<number, (event: any) => void>()

    constructor(url: string, token: string, onStateChange: (id: string, state: any) => void, onReady?: () => void) {
        // Normalize URL: http(s) -> ws(s)
        let wsUrl = url.replace(/^http/, 'ws')

        // Remove trailing slash if present
        if (wsUrl.endsWith('/')) wsUrl = wsUrl.slice(0, -1)

        const knownSuffixes = ['/api/websocket', '/api', '/config/dashboard']
        for (const suffix of knownSuffixes) {
            if (wsUrl.endsWith(suffix)) {
                wsUrl = wsUrl.slice(0, -suffix.length)
            }
        }

        wsUrl += '/api/websocket'

        this.url = wsUrl

        // SMART TOKEN EXTRACTION (in case DB has corrupted data)
        const jwtMatch = token.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)
        const extracted = jwtMatch ? jwtMatch[0] : token

        // Aggressively strip all whitespace (newlines from copy-paste)
        this.token = extracted.replace(/\s/g, '').replace(/[^\x00-\x7F]/g, "")
        this.onStateChange = onStateChange
        this.onReady = onReady
    }

    connect() {
        if (this.connectionPromise) return this.connectionPromise

        this.connectionPromise = new Promise((resolve, reject) => {
            console.log('🔌 Connecting to HA WebSocket:', this.url)
            this.isClosedExplicitly = false

            try {
                this.ws = new WebSocket(this.url)
            } catch (e) {
                console.error("Failed to create WebSocket", e)
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
                    this.handleMessage(message, resolve, reject)
                } catch (e) {
                    console.error("Error parsing WS message", e)
                }
            }

            this.ws.onerror = (error) => {
                console.error('🔌 WS Error:', error)
                // Reject only if it's the initial connection attempt
                if (!this.authenticated) reject(error)
            }

            this.ws.onclose = () => {
                console.log('🔌 WS Closed')
                this.authenticated = false
                this.connectionPromise = null

                // Reject all pending requests
                this.pendingRequests.forEach((p) => p.reject(new Error('WebSocket closed')))
                this.pendingRequests.clear()

                // Clear subscriptions? They are invalid on new connection usually,
                // but HA might need re-subscribing. 
                // We should technically re-subscribe all.
                // For now, let's just clear to avoid leaks/stale ID mappings (IDs reset on new connection).
                this.eventSubscriptions.clear()

                if (!this.isClosedExplicitly) {
                    this.scheduleReconnect()
                }
            }
        })

        return this.connectionPromise
    }

    private scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('🔌 Max reconnect attempts reached')
            return
        }

        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
        console.log(`🔌 Reconnecting in ${delay}ms...`)

        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++
            this.connect()
        }, delay)
    }

    private handleMessage(message: any, resolve: any, reject: any) {
        // Auth Flow
        if (message.type === 'auth_required') {
            this.sendAuth()
            return
        }

        if (message.type === 'auth_ok') {
            this.authenticated = true
            import('./logger').then(({ logger }) => logger.info('✅ Auth OK - Re-subscribing & Refreshing State'))
            this.subscribeStateChanges()
            this.flushQueue()
            if (this.onReady) this.onReady()
            resolve() // Connect promise resolves here
            return
        }

        if (message.type === 'auth_invalid') {
            console.error('Auth Invalid:', message.message)
            this.ws?.close()
            this.isClosedExplicitly = true
            reject(new Error(message.message))
            return
        }

        // Command Results
        // HA returns 'id' for command results.
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve: reqResolve, reject: reqReject } = this.pendingRequests.get(message.id)!

            if (message.success === false) {
                reqReject(new Error(message.error?.message || 'Command failed'))
            } else {
                reqResolve(message)
            }

            this.pendingRequests.delete(message.id)
            // Do NOT return here if it's a subscription result? 
            // Actually result comes separate from events.
            return
        }

        // Events
        if (message.type === 'event' && message.event) {

            // Dispatch to generic subscribers (mapped by ID)
            if (message.id && this.eventSubscriptions.has(message.id)) {
                this.eventSubscriptions.get(message.id)!(message.event)
            }

            // Keep Legacy Hardcoded State Changed for now (redundant if using subscription map but safe)
            if (message.event.event_type === 'state_changed') {
                const { entity_id, new_state } = message.event.data
                // import('./logger').then(({ logger }) => logger.info(`🔌 Event: ${entity_id} -> ${new_state?.state}`))
                this.onStateChange(entity_id, new_state)
            }
        }
    }

    private sendAuth() {
        this.ws?.send(JSON.stringify({
            type: 'auth',
            access_token: this.token
        }))
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

    private flushQueue() {
        while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift()
            if (msg && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(msg)
            }
        }
    }

    public sendMessage(payload: any, timeoutMs = 10000): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.idCounter++

            // Add timeout to prevent infinite hang
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id)
                    console.warn(`⏱️ WebSocket timeout after ${timeoutMs}ms for message ID ${id}`)
                    reject(new Error(`WebSocket timeout after ${timeoutMs}ms`))
                }
            }, timeoutMs)

            this.pendingRequests.set(id, {
                resolve: (res) => { clearTimeout(timeout); resolve(res) },
                reject: (err) => { clearTimeout(timeout); reject(err) }
            })

            // Construct message
            const message = JSON.stringify({
                id,
                ...payload
            })

            // Only send if OPEN and AUTHENTICATED
            if (this.isConnected()) {
                this.ws!.send(message)
            } else {
                // Buffer it
                console.warn(`⚠️ WS Not Ready (Auth: ${this.authenticated}, State: ${this.ws?.readyState}). Buffering message ID ${id}`)
                this.messageQueue.push(message)

                // Trigger reconnect if it looks dead
                if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
                    this.connect();
                }
            }
        })
    }

    public isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
    }

    public getStatus(): string {
        return `Authenticated: ${this.authenticated}, ReadyState: ${this.ws?.readyState}, Queue: ${this.messageQueue.length}`;
    }

    /**
     * Subscribe to a specific event type.
     * Returns an unsubscribe function.
     */
    public async subscribeEvents(eventType: string, callback: (event: any) => void): Promise<() => void> {
        try {
            // Send subscription command
            const result = await this.sendMessage({
                type: 'subscribe_events',
                event_type: eventType
            });

            // result.id is the subscription ID (same as command ID in HA)
            const subscriptionId = result.id;

            // Register callback
            this.eventSubscriptions.set(subscriptionId, callback);

            console.log(`✅ Subscribed to ${eventType} (ID: ${subscriptionId})`);

            // Return unsubscribe function
            return () => {
                if (this.eventSubscriptions.has(subscriptionId)) {
                    this.eventSubscriptions.delete(subscriptionId);
                    // Optionally send unsubscribe command to HA if supported/needed
                    // HA doesn't explicitly require unsubscribing for simple clients, 
                    // but 'unsubscribe_events' command exists taking 'subscription': id
                }
            };
        } catch (e) {
            console.error(`❌ Failed to subscribe to ${eventType}`, e);
            throw e;
        }
    }

    public close() {
        this.isClosedExplicitly = true
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.ws?.close()
    }
}
