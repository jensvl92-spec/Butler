export class HAWebSocket {
    constructor(url, token, onStateChange, onReady) {
        Object.defineProperty(this, "ws", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "url", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "token", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "idCounter", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: Date.now()
        });
        // Store resolve/reject for pending commands
        Object.defineProperty(this, "pendingRequests", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        Object.defineProperty(this, "onStateChange", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "onReady", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "connectionPromise", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "authenticated", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        // Message Queue for buffering commands before Auth
        Object.defineProperty(this, "messageQueue", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        // Auto-reconnect properties
        Object.defineProperty(this, "reconnectTimer", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "reconnectAttempts", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "maxReconnectAttempts", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 5
        });
        Object.defineProperty(this, "isClosedExplicitly", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        // Normalize URL: http(s) -> ws(s)
        let wsUrl = url.replace(/^http/, 'ws');
        // Remove trailing slash if present
        if (wsUrl.endsWith('/'))
            wsUrl = wsUrl.slice(0, -1);
        const knownSuffixes = ['/api/websocket', '/api', '/config/dashboard'];
        for (const suffix of knownSuffixes) {
            if (wsUrl.endsWith(suffix)) {
                wsUrl = wsUrl.slice(0, -suffix.length);
            }
        }
        wsUrl += '/api/websocket';
        this.url = wsUrl;
        // SMART TOKEN EXTRACTION (in case DB has corrupted data)
        const jwtMatch = token.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        const extracted = jwtMatch ? jwtMatch[0] : token;
        // Aggressively strip all whitespace (newlines from copy-paste)
        this.token = extracted.replace(/\s/g, '').replace(/[^\x00-\x7F]/g, "");
        this.onStateChange = onStateChange;
        this.onReady = onReady;
    }
    connect() {
        if (this.connectionPromise)
            return this.connectionPromise;
        this.connectionPromise = new Promise((resolve, reject) => {
            console.log('🔌 Connecting to HA WebSocket:', this.url);
            this.isClosedExplicitly = false;
            try {
                this.ws = new WebSocket(this.url);
            }
            catch (e) {
                console.error("Failed to create WebSocket", e);
                this.scheduleReconnect();
                return;
            }
            this.ws.onopen = () => {
                console.log('🔌 WS Open');
                this.reconnectAttempts = 0;
            };
            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message, resolve, reject);
                }
                catch (e) {
                    console.error("Error parsing WS message", e);
                }
            };
            this.ws.onerror = (error) => {
                console.error('🔌 WS Error:', error);
                // Reject only if it's the initial connection attempt
                if (!this.authenticated)
                    reject(error);
            };
            this.ws.onclose = () => {
                console.log('🔌 WS Closed');
                this.authenticated = false;
                this.connectionPromise = null;
                // Reject all pending requests
                this.pendingRequests.forEach((p) => p.reject(new Error('WebSocket closed')));
                this.pendingRequests.clear();
                // Clear queue? Maybe keep it for next reconnect?
                // Let's keep queue for resilience if it was just a blip.
                if (!this.isClosedExplicitly) {
                    this.scheduleReconnect();
                }
            };
        });
        return this.connectionPromise;
    }
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('🔌 Max reconnect attempts reached');
            return;
        }
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        console.log(`🔌 Reconnecting in ${delay}ms...`);
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++;
            this.connect();
        }, delay);
    }
    handleMessage(message, resolve, reject) {
        // Auth Flow
        if (message.type === 'auth_required') {
            this.sendAuth();
            return;
        }
        if (message.type === 'auth_ok') {
            this.authenticated = true;
            this.subscribeStateChanges();
            this.flushQueue();
            if (this.onReady)
                this.onReady();
            resolve(); // Connect promise resolves here
            return;
        }
        if (message.type === 'auth_invalid') {
            console.error('Auth Invalid:', message.message);
            this.ws?.close();
            this.isClosedExplicitly = true;
            reject(new Error(message.message));
            return;
        }
        // Command Results
        // HA returns 'id' for command results.
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve: reqResolve, reject: reqReject } = this.pendingRequests.get(message.id);
            if (message.success === false) {
                // Or typically message.type === 'result' && message.success === false
                // HA returns success: false for errors
                reqReject(new Error(message.error?.message || 'Command failed'));
            }
            else {
                reqResolve(message);
            }
            this.pendingRequests.delete(message.id);
            return;
        }
        // Events
        if (message.type === 'event' && message.event) {
            if (message.event.event_type === 'state_changed') {
                const { entity_id, new_state } = message.event.data;
                import('./logger').then(({ logger }) => logger.info(`🔌 Event: ${entity_id} -> ${new_state?.state}`));
                this.onStateChange(entity_id, new_state);
            }
        }
    }
    sendAuth() {
        this.ws?.send(JSON.stringify({
            type: 'auth',
            access_token: this.token
        }));
    }
    subscribeStateChanges() {
        import('./logger').then(({ logger }) => {
            logger.info('🔌 Subscribing to state_changed events');
            this.sendMessage({
                type: 'subscribe_events',
                event_type: 'state_changed'
            }).then(() => logger.info('✅ Subscribed to state_changed'))
                .catch(err => logger.error('❌ Subscription Failed', err));
        });
    }
    flushQueue() {
        while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift();
            if (msg && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(msg);
            }
        }
    }
    sendMessage(payload) {
        return new Promise((resolve, reject) => {
            const id = this.idCounter++;
            this.pendingRequests.set(id, { resolve, reject });
            // Construct message
            const message = JSON.stringify({
                id,
                ...payload
            });
            // Only send if OPEN and AUTHENTICATED
            // (Unless it's an auth message, but sendAuth uses ws.send directly)
            if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
                this.ws.send(message);
            }
            else {
                // Buffer it
                this.messageQueue.push(message);
            }
        });
    }
    close() {
        this.isClosedExplicitly = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.ws?.close();
    }
}
