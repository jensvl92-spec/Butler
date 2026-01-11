export interface HAConnection {
  id: string;
  user_id: string;
  name: string;
  api_url: string;
  api_token: string;   // uit je database / Supabase
  token: string;       // alias voor gebruik in je app
  created_at: string;
  updated_at: string;
}

export interface Room {
  id: string;
  connection_id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  connection_id: string;
  user_message: string;
  ai_response: string;
  language: string;
  actions_taken: Action[];
  scheduled_actions?: ScheduledAction[];
  created_at: string;
}

export interface ScheduledAction {
  title: string;
  delay_seconds: number;
  actions: Action[];
}

export interface Action {
  type: 'light' | 'switch' | 'climate' | 'media' | 'scene' | string;
  entity_id: string;
  service: string;
  data?: Record<string, any>;
  result?: 'success' | 'error' | 'pending';
  error_message?: string;
}

export interface UserSettings {
  id: string;
  user_id: string;
  preferred_language: string;
  theme: 'light' | 'dark';
  created_at: string;
  updated_at: string;
}

export interface HADevice {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
}

export interface HAService {
  domain: string;
  service: string;
  description: string;
  fields?: Record<string, any>;
}

export interface LLMRequest {
  user_message: string;
  connection_id: string;
  language: string;
  available_devices: HADevice[];
  available_services: Record<string, any>;
  rooms: Room[];
  context?: string;
}

export interface LLMResponse {
  text: string;
  actions: Action[];
  scheduled_actions?: ScheduledAction[];
  language: string;
  confidence: number;
  scheduled_tasks?: number;
  logs?: string[];
  conversation_mode?: boolean;
}

export interface UIState {
  language: string;
  labels: Record<string, string>;
  placeholders: Record<string, string>;
  messages: Record<string, string>;
}

export interface Suggestion {
  id: string;
  title: string;
  description: string;
  actions: any[];
  scheduled_actions?: any[];
  status: 'pending' | 'accepted' | 'rejected';
}
