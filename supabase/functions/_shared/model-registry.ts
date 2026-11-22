/**
 * Centralized Model Registry & Resilience Layer (Supabase Edge Functions)
 *
 * Single source of truth for all backend LLM calls & proactive workers.
 * Eliminates hardcoded/retired model IDs across functions and provides
 * automatic ordered fallback chains on 404/410/429/5xx.
 */

export type BackendModelTier =
    | 'fast_interactive'
    | 'high_accuracy'
    | 'lite_fast'
    | 'deep_reasoning'
    | 'embedding';

export interface TierConfig {
    primary: string;
    fallbacks: string[];
    defaultReasoningEffort?: 'low' | 'medium' | 'high';
}

export const MODEL_TIERS: Record<BackendModelTier, TierConfig> = {
    // Fast everyday tool calling & interactive responses
    fast_interactive: {
        primary: Deno.env.get('LLM_MODEL_FAST') || 'google/gemini-3.8-flash',
        fallbacks: ['google/gemini-4-hydrogen', 'google/gemini-3.5-flash-lite'],
        defaultReasoningEffort: 'low'
    },
    // Higher precision / low hallucination tasks (daily briefings, automation validation)
    high_accuracy: {
        primary: Deno.env.get('LLM_MODEL_ACCURATE') || 'google/gemini-4-hydrogen',
        fallbacks: ['google/gemini-3.8-flash', 'google/gemini-4-argon'],
        defaultReasoningEffort: 'medium'
    },
    // Ultra-fast, low-cost classification / formatting / MCP tool normalization
    lite_fast: {
        primary: Deno.env.get('LLM_MODEL_LITE') || 'google/gemini-3.5-flash-lite',
        fallbacks: ['google/gemini-3.8-flash'],
        defaultReasoningEffort: 'low'
    },
    // Heavy async background reasoning (nightly pattern mining, habit correlation, automation engineering)
    deep_reasoning: {
        primary: Deno.env.get('LLM_MODEL_REASONING') || 'google/gemini-4-argon',
        fallbacks: ['google/gemini-4-hydrogen', 'google/gemini-3.8-flash'],
        defaultReasoningEffort: 'high'
    },
    // Vector embeddings via OpenRouter (requires provider prefix!)
    embedding: {
        primary: Deno.env.get('LLM_EMBEDDING_MODEL') || 'openai/text-embedding-3-small',
        fallbacks: []
    }
};

export function getOpenRouterApiKey(): string {
    return (Deno.env.get('LLM_API_KEY') || Deno.env.get('OPENROUTER_API_KEY') || '').trim();
}

export function getTierModel(tier: BackendModelTier): string {
    return MODEL_TIERS[tier].primary;
}

export function getTierFallbackList(tier: BackendModelTier, overrideModel?: string): string[] {
    const cfg = MODEL_TIERS[tier];
    const base = overrideModel ? [overrideModel, cfg.primary, ...cfg.fallbacks] : [cfg.primary, ...cfg.fallbacks];
    return Array.from(new Set(base.filter(Boolean)));
}

export function isGeminiNewGen(model: string): boolean {
    const lower = model.toLowerCase();
    return (
        lower.includes('gemini-3.5') ||
        lower.includes('gemini-3.6') ||
        lower.includes('gemini-3.7') ||
        lower.includes('gemini-3.8') ||
        lower.includes('gemini-4') ||
        lower.includes('gemini-flash-latest')
    );
}

/**
 * Fetch wrapper with AbortController timeout so upstream hangs never exhaust Edge Function wall-clock limits.
 */
export async function fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = 30000
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}
