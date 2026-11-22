/**
 * Centralized Model Registry & Resilience Layer (Frontend)
 *
 * Single source of truth for active LLM models across Google Gemini API and OpenRouter.
 * Prevents model-retirement breakages via automatic ordered failover chains and
 * handles Gemini 3.6+/3.8/4.x API rules (reasoning_effort instead of deprecated temperature).
 */

export type AIProvider = 'gemini' | 'openrouter';
export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high';
export type ModelTier = 'fast_interactive' | 'high_accuracy' | 'lite_fast' | 'deep_reasoning';

export const GOOGLE_GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.8-flash';

export interface ModelPreset {
    id: string;
    label: string;
    tier: ModelTier;
    description: string;
}

export const GEMINI_MODEL_PRESETS: ModelPreset[] = [
    {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash (Aanbevolen — Snel & Betrouwbaar)',
        tier: 'fast_interactive',
        description: 'Beste balans tussen snelheid, slimme tool-calling en kosten ($0.75/$3.75 per 1M).'
    },
    {
        id: 'gemini-4-hydrogen',
        label: 'Gemini 4 Hydrogen (Hoogste Precisie & Logica)',
        tier: 'high_accuracy',
        description: '5x minder hallucinaties, ideaal voor complexe taken en dagelijkse assistentie.'
    },
    {
        id: 'gemini-3.5-flash-lite',
        label: 'Gemini 3.5 Flash-Lite (Ultrasnel & Goedkoopst)',
        tier: 'lite_fast',
        description: 'Laagste latency voor snelle spraakcommando\'s en basisbediening.'
    },
    {
        id: 'gemini-4-argon',
        label: 'Gemini 4 Argon (Diepe Redenering)',
        tier: 'deep_reasoning',
        description: 'Sterk reasoning-model voor complexe automatiseringen en analyses.'
    },
    {
        id: 'gemini-flash-latest',
        label: 'Gemini Flash Latest (Auto-Update Alias)',
        tier: 'fast_interactive',
        description: 'Verwijst automatisch naar Google\'s nieuwste stabiele Flash-model.'
    }
];

export const OPENROUTER_MODEL_PRESETS: ModelPreset[] = [
    {
        id: 'google/gemini-3.8-flash',
        label: 'Gemini 3.8 Flash (Aanbevolen — Snel & Betrouwbaar)',
        tier: 'fast_interactive',
        description: 'Snel, betrouwbaar agent-model via OpenRouter met Auto Exacto tool routing.'
    },
    {
        id: 'google/gemini-4-hydrogen',
        label: 'Gemini 4 Hydrogen (Hoogste Precisie & Logica)',
        tier: 'high_accuracy',
        description: 'Hoogste tool-call betrouwbaarheid en sterkste dagelijkse logica.'
    },
    {
        id: 'google/gemini-3.5-flash-lite',
        label: 'Gemini 3.5 Flash-Lite (Ultrasnel & Goedkoopst)',
        tier: 'lite_fast',
        description: 'Minimale latency en kosten via OpenRouter.'
    },
    {
        id: 'google/gemini-4-argon',
        label: 'Gemini 4 Argon (Diepe Redenering)',
        tier: 'deep_reasoning',
        description: 'Frontier reasoning-model voor complexe analyses en automatiseringen.'
    },
    {
        id: 'anthropic/claude-sonnet-4.6',
        label: 'Claude Sonnet 4.6 (Alternatief via OpenRouter)',
        tier: 'high_accuracy',
        description: 'Sterke taalbeheersing en betrouwbare tool-calling als niet-Google alternatief.'
    }
];

/**
 * Automatic failover chains so Butler never breaks when a model retires or is rate-limited.
 */
export function getFailoverModels(primaryModel: string, provider: AIProvider): string[] {
    const baseChain = provider === 'gemini'
        ? ['gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-3.5-flash-lite', 'gemini-flash-latest']
        : ['google/gemini-3.8-flash', 'google/gemini-4-hydrogen', 'google/gemini-3.5-flash-lite'];

    const ordered = [primaryModel, ...baseChain.filter(m => m !== primaryModel)];
    return Array.from(new Set(ordered));
}

/**
 * Escalation model chains for Self-Escalating Adaptive Reasoning (`consult_deep_reasoner`).
 * - 'medium' -> Gemini 4 Hydrogen (high accuracy, 5x fewer hallucinations, balanced latency)
 * - 'high'   -> Gemini 4 Argon (frontier deep reasoning for complex logic, YAML, planning, coding)
 */
export function getEscalationModels(depth: 'medium' | 'high', provider: AIProvider): string[] {
    if (depth === 'high') {
        return provider === 'gemini'
            ? ['gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash']
            : ['google/gemini-4-argon', 'google/gemini-4-hydrogen', 'google/gemini-3.8-flash'];
    }
    return provider === 'gemini'
        ? ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash']
        : ['google/gemini-4-hydrogen', 'google/gemini-4-argon', 'google/gemini-3.8-flash'];
}

/**
 * Sanitize user-entered or stored model IDs while preserving valid OpenRouter routing tags
 * (e.g. `:free`, `:nitro`, `:exacto`, `:floor`, `:thinking`).
 */
export function sanitizeModelId(raw: string | undefined | null, provider: AIProvider): string {
    if (!raw) return provider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL;
    let clean = raw.trim();

    // 1. Strip surrounding quotes or backticks
    clean = clean.replace(/^[ "'`]+|[ "'`]+$/g, '').trim();

    // 2. If user pasted a full URL or path containing '/models/'
    if (clean.includes('/models/')) {
        clean = clean.split('/models/')[1];
    }

    // 3. Strip query parameters
    if (clean.includes('?')) {
        clean = clean.split('?')[0];
    }

    // 4. Strip Google REST action suffixes like :generateContent / :streamGenerateContent
    //    WITHOUT stripping valid OpenRouter tags like :free, :nitro, :floor, :exacto
    clean = clean.replace(/:(generateContent|streamGenerateContent|batchGenerateContent|countTokens)$/i, '');

    // 5. Strip Vertex AI / Model Garden prefixes
    clean = clean.replace(/^.*publishers\/google\/models\//i, '');
    clean = clean.replace(/^publishers\/[^\/]+\/models\//i, '');
    clean = clean.replace(/^models\//i, '');

    // 6. Strip trailing display notes like " (latest)"
    clean = clean.split(' ')[0].split('(')[0].trim();

    // 7. Auto-migrate known retired/broken legacy slugs seamlessly
    const bareLower = clean.replace(/^google\//i, '').toLowerCase();
    const retiredMigrations: Record<string, string> = {
        'gemini-2.0-flash': 'gemini-3.8-flash',
        'gemini-2.0-flash-exp': 'gemini-3.8-flash',
        'gemini-2.0-flash-lite': 'gemini-3.5-flash-lite',
        'gemini-2.5-flash': 'gemini-3.8-flash',
        'gemini-2.5-pro': 'gemini-3.8-flash',
        'gemini-3.0-flash': 'gemini-3.8-flash',
        'gemini-3-flash': 'gemini-3.8-flash',
        'gemini-3-flash-preview': 'gemini-3.8-flash',
        'gemini-3-flash-lite': 'gemini-3.5-flash-lite',
        'gemini-3.5-flash': 'gemini-3.8-flash',
        'gemini-3.6-flash': 'gemini-3.8-flash',
        'gemini-3.7-flash': 'gemini-3.8-flash',
        'gemini-3.1-pro': 'gemini-4-argon',
        'gemini-3.1-pro-preview': 'gemini-4-argon'
    };

    if (retiredMigrations[bareLower]) {
        const migrated = retiredMigrations[bareLower];
        clean = provider === 'openrouter' ? `google/${migrated}` : migrated;
    }

    if (provider === 'gemini') {
        clean = clean.replace(/^google\//i, '');
        // Direct Google API does not accept OpenRouter routing suffixes
        clean = clean.replace(/:(free|nitro|floor|exacto|batch)$/i, '');
    } else {
        if (!clean.includes('/')) {
            clean = `google/${clean}`;
        }
    }

    return clean || (provider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL);
}

/**
 * Gemini 3.6+, 3.8, 3.5-flash-lite, and Gemini 4 deprecate sampling params (`temperature`, `top_p`, `top_k`)
 * and use `reasoning_effort` instead.
 */
export function supportsTemperatureParam(model: string): boolean {
    const lower = model.toLowerCase();
    if (lower.includes('gemini-3.5') || lower.includes('gemini-3.6') || lower.includes('gemini-3.7') || lower.includes('gemini-3.8') || lower.includes('gemini-4') || lower.includes('gemini-flash-latest')) {
        return false;
    }
    return true;
}

export function supportsReasoningEffort(model: string): boolean {
    const lower = model.toLowerCase();
    return lower.includes('gemini-3') || lower.includes('gemini-4') || lower.includes('gemini-flash-latest');
}

export interface AIResolvedConfig {
    apiKey: string;
    provider: AIProvider;
    model: string;
    endpoint: string;
    fallbackModels: string[];
    reasoningEffort: ReasoningEffort;
}

/**
 * Resolves the active AI provider, API key, and model cleanly.
 * Respects the user's explicit provider choice (`butler.ai_provider`) instead of letting
 * a stale Gemini key hijack OpenRouter selection.
 */
export function resolveAIConfig(
    providedKey?: string,
    providedModel?: string,
    providedProvider?: AIProvider
): AIResolvedConfig {
    const storedProvider = localStorage.getItem('butler.ai_provider') as AIProvider | null;
    const geminiKey = (
        localStorage.getItem('butler.gemini_api_key') ||
        (import.meta as any).env?.VITE_GEMINI_API_KEY || ''
    ).trim();
    const openRouterKey = (
        localStorage.getItem('butler.openrouter_api_key') ||
        (import.meta as any).env?.VITE_OPENROUTER_API_KEY || ''
    ).trim();
    const genericKey = (localStorage.getItem('butler.api_key') || '').trim();

    let provider: AIProvider = providedProvider || storedProvider || 'gemini';
    let apiKey = (providedKey || '').trim();

    if (apiKey) {
        // Explicit key passed directly (e.g., from Settings Test button)
        if (!providedProvider) {
            if (apiKey.startsWith('sk-or-')) provider = 'openrouter';
            else if (apiKey.startsWith('AIzaSy')) provider = 'gemini';
        }
    } else {
        // Pick the key that matches the explicitly chosen provider FIRST
        if (provider === 'openrouter') {
            apiKey = openRouterKey || (genericKey.startsWith('sk-or-') ? genericKey : '') || geminiKey;
            if (!openRouterKey && !genericKey.startsWith('sk-or-') && geminiKey) {
                provider = 'gemini';
            }
        } else {
            apiKey = geminiKey || (genericKey.startsWith('AIzaSy') ? genericKey : '') || openRouterKey || genericKey;
            if (!geminiKey && !genericKey.startsWith('AIzaSy') && openRouterKey) {
                provider = 'openrouter';
            }
        }
    }

    const storedModel = provider === 'openrouter'
        ? (localStorage.getItem('butler.openrouter_model') || localStorage.getItem('butler.llm_model'))
        : (localStorage.getItem('butler.gemini_model') || localStorage.getItem('butler.llm_model'));

    const defaultModel = provider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL;
    const model = sanitizeModelId(providedModel || storedModel || defaultModel, provider);
    const endpoint = provider === 'gemini' ? GOOGLE_GEMINI_API_URL : OPENROUTER_API_URL;
    const fallbackModels = getFailoverModels(model, provider);

    const storedEffort = localStorage.getItem('butler.reasoning_effort') as ReasoningEffort | null;
    const reasoningEffort: ReasoningEffort =
        storedEffort && ['auto', 'low', 'medium', 'high'].includes(storedEffort)
            ? storedEffort
            : 'auto';

    return { apiKey, provider, model, endpoint, fallbackModels, reasoningEffort };
}
