export interface HAConnection {
    id: string
    api_url: string
    api_token: string
    fcm_token?: string
}

export interface AIAction {
    type: string
    entity_id: string
    service: string
    data?: Record<string, any>
    error?: string
}

export interface AIScheduledAction {
    title: string
    delay_seconds: number
    actions: AIAction[]
}

export interface AIResponse {
    text: string
    actions: AIAction[]
    language: string
    memory_to_save?: string
    scheduled_actions?: AIScheduledAction[]
    tool_debug_info?: any
}

export interface HAEvent {
    event_type: string
    entity_id?: string
    state?: string
    attributes?: Record<string, any>
    timestamp: string
}
