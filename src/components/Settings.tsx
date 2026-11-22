import React, { useState, useEffect } from 'react';
import { registerPlugin } from '@capacitor/core';
import { signOut } from '../utils/auth';
import { supabase } from '../lib/supabase';
import { useApp } from '../lib/AppContext';
import {
    GEMINI_MODEL_PRESETS,
    OPENROUTER_MODEL_PRESETS,
    DEFAULT_GEMINI_MODEL,
    DEFAULT_OPENROUTER_MODEL,
    GOOGLE_GEMINI_API_URL,
    OPENROUTER_API_URL,
    ReasoningEffort,
    sanitizeModelId,
    supportsReasoningEffort
} from '../lib/services/modelRegistry';
import { PROACTIVE_WORKERS, triggerProactiveWorker, ProactiveWorkerId } from '../lib/services/proactiveWorkers';
import { logger } from '../utils/logger';

interface FloatingButtonPlugin {
    start(): Promise<{ started: boolean }>;
    stop(): Promise<{ stopped: boolean }>;
    hasOverlayPermission(): Promise<{ hasPermission: boolean }>;
    requestOverlayPermission(): Promise<void>;
    checkPendingVoiceInput(): Promise<{ pending: boolean }>;
}

const FloatingButton = registerPlugin<FloatingButtonPlugin>('FloatingButton');

export const GEMINI_MODELS = GEMINI_MODEL_PRESETS;
export const OPENROUTER_MODELS = OPENROUTER_MODEL_PRESETS;

interface SettingsProps {
    onClose?: () => void;
}

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
    const { activeConnection } = useApp();
    const [floatingEnabled, setFloatingEnabled] = useState(false);
    const [hasPermission, setHasPermission] = useState(false);
    const [snoozeUntil, setSnoozeUntil] = useState<number | null>(null);
    const [voiceAlertsEnabled, setVoiceAlertsEnabled] = useState(true);
    const [clearingHistory, setClearingHistory] = useState(false);

    // AI Brain Settings (Client-Side Google Gemini / OpenRouter)
    const [aiProvider, setAiProvider] = useState<'gemini' | 'openrouter'>('gemini');
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [llmModel, setLlmModel] = useState(DEFAULT_GEMINI_MODEL);
    const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('auto');
    const [isCustomModel, setIsCustomModel] = useState(false);
    const [showApiKey, setShowApiKey] = useState(false);
    const [testingKey, setTestingKey] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [keySaved, setKeySaved] = useState(false);

    // Proactive Workers on-demand runner state
    const [runningWorker, setRunningWorker] = useState<ProactiveWorkerId | null>(null);
    const [workerStatus, setWorkerStatus] = useState<Record<string, { ok: boolean; msg: string }>>({});

    useEffect(() => {
        const savedEnabled = localStorage.getItem('floatingButton.enabled') === 'true';
        const savedSnooze = localStorage.getItem('floatingButton.snoozeUntil');

        const savedProvider = (localStorage.getItem('butler.ai_provider') as 'gemini' | 'openrouter') || 'gemini';
        setAiProvider(savedProvider);

        const providerKey = savedProvider === 'gemini'
            ? (localStorage.getItem('butler.gemini_api_key') || (import.meta as any).env?.VITE_GEMINI_API_KEY || '')
            : (localStorage.getItem('butler.openrouter_api_key') || (import.meta as any).env?.VITE_OPENROUTER_API_KEY || '');
        setApiKeyInput(providerKey);

        const savedModelRaw = savedProvider === 'gemini'
            ? (localStorage.getItem('butler.gemini_model') || localStorage.getItem('butler.llm_model') || DEFAULT_GEMINI_MODEL)
            : (localStorage.getItem('butler.openrouter_model') || localStorage.getItem('butler.llm_model') || DEFAULT_OPENROUTER_MODEL);
        const cleanSavedModel = sanitizeModelId(savedModelRaw, savedProvider);
        setLlmModel(cleanSavedModel);

        const presets = savedProvider === 'gemini' ? GEMINI_MODELS : OPENROUTER_MODELS;
        setIsCustomModel(!presets.some(m => m.id === cleanSavedModel));

        const savedEffort = localStorage.getItem('butler.reasoning_effort') as ReasoningEffort | null;
        if (savedEffort && ['auto', 'low', 'medium', 'high'].includes(savedEffort)) {
            setReasoningEffort(savedEffort);
        }

        if (savedSnooze) {
            const snoozeTime = parseInt(savedSnooze, 10);
            if (snoozeTime > Date.now()) {
                setSnoozeUntil(snoozeTime);
                setFloatingEnabled(false);
            } else {
                localStorage.removeItem('floatingButton.snoozeUntil');
                setFloatingEnabled(savedEnabled);
            }
        } else {
            setFloatingEnabled(savedEnabled);
        }

        checkPermission();

        const onVisChange = () => {
            if (document.visibilityState === 'visible') checkPermission();
        };
        document.addEventListener('visibilitychange', onVisChange);

        const savedVoiceAlerts = localStorage.getItem('settings.voiceAlerts');
        if (savedVoiceAlerts !== null) {
            setVoiceAlertsEnabled(savedVoiceAlerts === 'true');
        }

        return () => document.removeEventListener('visibilitychange', onVisChange);
    }, []);

    const checkPermission = async () => {
        try {
            const result = await FloatingButton.hasOverlayPermission();
            setHasPermission(result.hasPermission);
        } catch (e) {
            logger.warn('FloatingButton plugin not available (web mode)');
        }
    };

    const handleToggle = async () => {
        if (!floatingEnabled) {
            // Turning ON
            if (!hasPermission) {
                await FloatingButton.requestOverlayPermission();
                return;
            }

            try {
                await FloatingButton.start();
                setFloatingEnabled(true);
                localStorage.setItem('floatingButton.enabled', 'true');
                localStorage.removeItem('floatingButton.snoozeUntil');
                setSnoozeUntil(null);
            } catch (e: any) {
                logger.error('Failed to start floating button:', e);
                alert('Failed to enable floating button. Please grant overlay permission in settings.');
            }
        } else {
            // Turning OFF (indefinitely)
            await stopFloatingButton();
            localStorage.setItem('floatingButton.enabled', 'false');
        }
    };

    const stopFloatingButton = async () => {
        try {
            await FloatingButton.stop();
            setFloatingEnabled(false);
        } catch (e) {
            logger.warn('FloatingButton plugin not available');
        }
    };

    const handleSnooze = async (hours: number) => {
        const snoozeMs = hours * 60 * 60 * 1000;
        const snoozeTime = Date.now() + snoozeMs;

        await stopFloatingButton();
        setSnoozeUntil(snoozeTime);
        localStorage.setItem('floatingButton.snoozeUntil', snoozeTime.toString());
        localStorage.setItem('floatingButton.enabled', 'true'); // Remember it was enabled
    };

    const handleSnoozeUntilTomorrow = async () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(8, 0, 0, 0); // 8 AM tomorrow

        await stopFloatingButton();
        setSnoozeUntil(tomorrow.getTime());
        localStorage.setItem('floatingButton.snoozeUntil', tomorrow.getTime().toString());
        localStorage.setItem('floatingButton.enabled', 'true');
    };

    const formatSnoozeRemaining = () => {
        if (!snoozeUntil) return '';
        const remaining = snoozeUntil - Date.now();
        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
        return `${hours}h ${minutes}m remaining`;
    };

    return (
        <div className="settings-panel" style={{
            padding: '20px',
            background: 'var(--bg-card)',
            borderRadius: '16px',
            border: '1px solid var(--border)',
            maxHeight: '80vh',
            overflowY: 'auto'
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h2 style={{ margin: 0 }}>⚙️ Settings</h2>
                {onClose && <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>}
            </div>

            {/* AI Brain Section (Google Gemini & OpenRouter) */}
            <div style={{
                marginBottom: '24px',
                padding: '16px',
                background: 'rgba(99, 102, 241, 0.08)',
                borderRadius: '12px',
                border: '1px solid rgba(99, 102, 241, 0.25)'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                        🧠 AI Brain (Client-Side ReAct)
                    </h3>
                    <span style={{
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: '999px',
                        background: apiKeyInput ? '#dcfce7' : '#fef9c3',
                        color: apiKeyInput ? '#15803d' : '#854d0e'
                    }}>
                        {apiKeyInput ? (aiProvider === 'gemini' ? '🟢 Gemini Direct' : '🟢 OpenRouter') : '🟡 Sleutel Vereist'}
                    </span>
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '14px', lineHeight: '1.4' }}>
                    Butler draait direct op jouw toestel via een Single ReAct Orchestrator met live tools voor weer (dauwpunt & windstoten), Home Assistant besturing en geheugen.
                </p>

                {/* Provider Selector Tabs */}
                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                    <button
                        type="button"
                        onClick={() => {
                            setAiProvider('gemini');
                            const storedKey = localStorage.getItem('butler.gemini_api_key') || (import.meta as any).env?.VITE_GEMINI_API_KEY || '';
                            setApiKeyInput(storedKey);
                            const storedModel = sanitizeModelId(
                                localStorage.getItem('butler.gemini_model') || DEFAULT_GEMINI_MODEL,
                                'gemini'
                            );
                            setLlmModel(storedModel);
                            setIsCustomModel(!GEMINI_MODELS.some(m => m.id === storedModel));
                            setTestResult(null);
                        }}
                        style={{
                            flex: 1,
                            padding: '8px 10px',
                            borderRadius: '8px',
                            border: aiProvider === 'gemini' ? '2px solid #4f46e5' : '1px solid var(--border, #3a3a4a)',
                            background: aiProvider === 'gemini' ? 'rgba(79, 70, 229, 0.2)' : 'var(--bg-card, #1a1a24)',
                            color: 'var(--text-primary, #ffffff)',
                            fontWeight: aiProvider === 'gemini' ? 600 : 400,
                            cursor: 'pointer',
                            fontSize: '0.85rem'
                        }}
                    >
                        🔵 Google Gemini (Aanbevolen)
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setAiProvider('openrouter');
                            const storedKey = localStorage.getItem('butler.openrouter_api_key') || (import.meta as any).env?.VITE_OPENROUTER_API_KEY || '';
                            setApiKeyInput(storedKey);
                            const storedModel = sanitizeModelId(
                                localStorage.getItem('butler.openrouter_model') || DEFAULT_OPENROUTER_MODEL,
                                'openrouter'
                            );
                            setLlmModel(storedModel);
                            setIsCustomModel(!OPENROUTER_MODELS.some(m => m.id === storedModel));
                            setTestResult(null);
                        }}
                        style={{
                            flex: 1,
                            padding: '8px 10px',
                            borderRadius: '8px',
                            border: aiProvider === 'openrouter' ? '2px solid #4f46e5' : '1px solid var(--border, #3a3a4a)',
                            background: aiProvider === 'openrouter' ? 'rgba(79, 70, 229, 0.2)' : 'var(--bg-card, #1a1a24)',
                            color: 'var(--text-primary, #ffffff)',
                            fontWeight: aiProvider === 'openrouter' ? 600 : 400,
                            cursor: 'pointer',
                            fontSize: '0.85rem'
                        }}
                    >
                        🟣 OpenRouter
                    </button>
                </div>

                {/* Model Selector */}
                <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px', color: 'var(--text-primary, #ffffff)' }}>
                        AI Model ({aiProvider === 'gemini' ? 'Google AI Studio' : 'OpenRouter'})
                    </label>
                    <select
                        value={isCustomModel ? 'custom' : llmModel}
                        onChange={(e) => {
                            const val = e.target.value;
                            if (val === 'custom') {
                                setIsCustomModel(true);
                            } else {
                                setIsCustomModel(false);
                                setLlmModel(val);
                            }
                        }}
                        style={{
                            width: '100%',
                            padding: '10px 12px',
                            borderRadius: '8px',
                            border: isCustomModel ? '2px solid #818cf8' : '1px solid var(--border, #3a3a4a)',
                            background: 'var(--bg-elevated, #252532)',
                            color: 'var(--text-primary, #ffffff)',
                            fontSize: '0.85rem',
                            outline: 'none'
                        }}
                    >
                        {(aiProvider === 'gemini' ? GEMINI_MODELS : OPENROUTER_MODELS).map((m) => (
                            <option key={m.id} value={m.id} style={{ background: '#1a1a24', color: '#ffffff' }}>
                                {m.label}
                            </option>
                        ))}
                        <option value="custom" style={{ background: '#1a1a24', color: '#818cf8', fontWeight: 600 }}>
                            ✏️ Ander / Aangepast model (handmatig invoeren)...
                        </option>
                    </select>

                    {isCustomModel ? (
                        <div style={{
                            marginTop: '8px',
                            padding: '10px 12px',
                            background: 'rgba(99, 102, 241, 0.12)',
                            borderRadius: '8px',
                            border: '1px solid rgba(99, 102, 241, 0.35)'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#818cf8' }}>
                                    ✏️ Aangepast Model ID:
                                </span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setIsCustomModel(false);
                                        setLlmModel(aiProvider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL);
                                    }}
                                    style={{
                                        background: 'none',
                                        border: 'none',
                                        color: 'var(--text-secondary, #9ca3af)',
                                        fontSize: '0.75rem',
                                        cursor: 'pointer',
                                        textDecoration: 'underline'
                                    }}
                                >
                                    Standaard model herstellen
                                </button>
                            </div>
                            <input
                                type="text"
                                value={llmModel}
                                autoFocus
                                onChange={(e) => setLlmModel(e.target.value)}
                                onBlur={() => {
                                    const clean = sanitizeModelId(llmModel, aiProvider);
                                    setLlmModel(clean);
                                    const presets = aiProvider === 'gemini' ? GEMINI_MODELS : OPENROUTER_MODELS;
                                    if (presets.some(m => m.id === clean)) {
                                        setIsCustomModel(false);
                                    }
                                }}
                                placeholder={aiProvider === 'gemini' ? `bijv. ${DEFAULT_GEMINI_MODEL}` : `bijv. ${DEFAULT_OPENROUTER_MODEL}`}
                                style={{
                                    width: '100%',
                                    padding: '8px 10px',
                                    borderRadius: '6px',
                                    border: '1px solid var(--border, #3a3a4a)',
                                    background: 'var(--bg-elevated, #252532)',
                                    color: 'var(--text-primary, #ffffff)',
                                    caretColor: '#6366f1',
                                    fontSize: '0.85rem',
                                    fontFamily: 'monospace',
                                    outline: 'none'
                                }}
                            />
                            <p style={{ margin: '6px 0 0 0', fontSize: '0.72rem', color: 'var(--text-secondary, #9ca3af)', lineHeight: '1.3' }}>
                                💡 <strong>Tip:</strong> Butler migreert verlopen modellen automatisch naar het nieuwste actieve alternatief en valt bij rate-limits automatisch terug op de failover-keten.
                            </p>
                        </div>
                    ) : (
                        <div style={{ marginTop: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #9ca3af)' }}>
                                Actief model: <code style={{ color: '#818cf8', fontWeight: 600 }}>{llmModel}</code>
                            </span>
                            <button
                                type="button"
                                onClick={() => setIsCustomModel(true)}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    color: '#818cf8',
                                    fontSize: '0.75rem',
                                    cursor: 'pointer',
                                    textDecoration: 'underline',
                                    padding: '0'
                                }}
                            >
                                ✏️ Ander model invoeren
                            </button>
                        </div>
                    )}
                </div>

                {/* Reasoning Effort Selector */}
                {supportsReasoningEffort(llmModel) && (
                    <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px', color: 'var(--text-primary, #ffffff)' }}>
                            Denkniveau (Snelheid vs. Logica)
                        </label>
                        <select
                            value={reasoningEffort}
                            onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
                            style={{
                                width: '100%',
                                padding: '9px 12px',
                                borderRadius: '8px',
                                border: '1px solid var(--border, #3a3a4a)',
                                background: 'var(--bg-elevated, #252532)',
                                color: 'var(--text-primary, #ffffff)',
                                fontSize: '0.85rem',
                                outline: 'none'
                            }}
                        >
                            <option value="auto" style={{ background: '#1a1a24', color: '#ffffff' }}>
                                ✨ Automatisch / Adaptief (Aanbevolen — snel op Flash, escaleert zelf naar Hydrogen/Argon)
                            </option>
                            <option value="low" style={{ background: '#1a1a24', color: '#ffffff' }}>
                                ⚡ Altijd Laag (Snelste spraak & smart home acties)
                            </option>
                            <option value="medium" style={{ background: '#1a1a24', color: '#ffffff' }}>
                                ⚖️ Altijd Gemiddeld (Extra nauwkeurig voor analyses & planning)
                            </option>
                            <option value="high" style={{ background: '#1a1a24', color: '#ffffff' }}>
                                🧠 Altijd Hoog (Maximaal redeneren bij elke vraag)
                            </option>
                        </select>
                        {reasoningEffort === 'auto' && (
                            <p style={{ margin: '5px 0 0 0', fontSize: '0.72rem', color: 'var(--text-secondary, #9ca3af)', lineHeight: '1.35' }}>
                                Butler beantwoordt dagelijkse commando&apos;s razendsnel op <strong>low</strong> en schakelt bij complexe vragen, planning of automatiseringen zelf op naar <strong>Gemini 4 Hydrogen (medium)</strong> of <strong>Gemini 4 Argon (high)</strong>.
                            </p>
                        )}
                    </div>
                )}

                {/* API Key Input */}
                <div style={{ marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary, #ffffff)' }}>
                            {aiProvider === 'gemini' ? 'Google Gemini API-Sleutel (AIzaSy...)' : 'OpenRouter API-Sleutel (sk-or-...)'}
                        </label>
                        {aiProvider === 'gemini' && (
                            <a
                                href="https://aistudio.google.com/app/apikey"
                                target="_blank"
                                rel="noreferrer"
                                style={{ fontSize: '0.75rem', color: '#818cf8', textDecoration: 'none' }}
                            >
                                🔗 Gratis ophalen bij Google
                            </a>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                            type={showApiKey ? 'text' : 'password'}
                            value={apiKeyInput}
                            onChange={(e) => {
                                const val = e.target.value;
                                setApiKeyInput(val);
                                if (val.startsWith('AIzaSy') && aiProvider !== 'gemini') {
                                    setAiProvider('gemini');
                                    setLlmModel(DEFAULT_GEMINI_MODEL);
                                    setIsCustomModel(false);
                                } else if (val.startsWith('sk-or-') && aiProvider !== 'openrouter') {
                                    setAiProvider('openrouter');
                                    setLlmModel(DEFAULT_OPENROUTER_MODEL);
                                    setIsCustomModel(false);
                                }
                            }}
                            placeholder={aiProvider === 'gemini' ? 'AIzaSy...' : 'sk-or-v1-...'}
                            style={{
                                flex: 1,
                                padding: '10px 12px',
                                borderRadius: '8px',
                                border: '1px solid var(--border, #3a3a4a)',
                                background: 'var(--bg-elevated, #252532)',
                                color: 'var(--text-primary, #ffffff)',
                                caretColor: '#6366f1',
                                fontSize: '0.9rem',
                                outline: 'none'
                            }}
                        />
                        <button
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            style={{
                                padding: '8px 14px',
                                borderRadius: '8px',
                                border: '1px solid var(--border, #3a3a4a)',
                                background: 'var(--bg-card, #1a1a24)',
                                color: 'var(--text-primary, #ffffff)',
                                cursor: 'pointer',
                                fontSize: '0.8rem'
                            }}
                        >
                            {showApiKey ? 'Verberg' : 'Toon'}
                        </button>
                    </div>
                </div>

                {/* Action Buttons */}
                <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button
                        onClick={() => {
                            const trimmed = apiKeyInput.trim();
                            const resolvedProvider: 'gemini' | 'openrouter' = trimmed.startsWith('sk-or-')
                                ? 'openrouter'
                                : trimmed.startsWith('AIzaSy')
                                    ? 'gemini'
                                    : aiProvider;
                            const cleanModel = sanitizeModelId(llmModel, resolvedProvider);
                            setAiProvider(resolvedProvider);
                            setLlmModel(cleanModel);
                            const activePresets = resolvedProvider === 'gemini' ? GEMINI_MODELS : OPENROUTER_MODELS;
                            setIsCustomModel(!activePresets.some(m => m.id === cleanModel));

                            localStorage.setItem('butler.ai_provider', resolvedProvider);
                            if (resolvedProvider === 'gemini') {
                                localStorage.setItem('butler.gemini_api_key', trimmed);
                                localStorage.setItem('butler.gemini_model', cleanModel);
                            } else {
                                localStorage.setItem('butler.openrouter_api_key', trimmed);
                                localStorage.setItem('butler.openrouter_model', cleanModel);
                            }
                            localStorage.setItem('butler.api_key', trimmed);
                            localStorage.setItem('butler.llm_model', cleanModel);
                            localStorage.setItem('butler.reasoning_effort', reasoningEffort);
                            setKeySaved(true);
                            setTimeout(() => setKeySaved(false), 2500);
                        }}
                        style={{
                            flex: 1,
                            padding: '10px 12px',
                            borderRadius: '8px',
                            background: '#4f46e5',
                            color: '#ffffff',
                            border: 'none',
                            fontWeight: 600,
                            cursor: 'pointer',
                            fontSize: '0.85rem'
                        }}
                    >
                        {keySaved ? '✅ Opgeslagen!' : '💾 Opslaan'}
                    </button>
                    <button
                        onClick={async () => {
                            const trimmed = apiKeyInput.trim();
                            const resolvedProvider: 'gemini' | 'openrouter' = trimmed.startsWith('sk-or-')
                                ? 'openrouter'
                                : trimmed.startsWith('AIzaSy')
                                    ? 'gemini'
                                    : aiProvider;
                            const isGemini = resolvedProvider === 'gemini';
                            const keyToTest = trimmed ||
                                (isGemini
                                    ? localStorage.getItem('butler.gemini_api_key') || (import.meta as any).env?.VITE_GEMINI_API_KEY
                                    : localStorage.getItem('butler.openrouter_api_key') || (import.meta as any).env?.VITE_OPENROUTER_API_KEY);

                            if (!keyToTest) {
                                setTestResult({ success: false, message: 'Vul eerst een API-sleutel in.' });
                                return;
                            }
                            setTestingKey(true);
                            setTestResult(null);

                            const cleanModel = sanitizeModelId(llmModel, resolvedProvider);
                            setLlmModel(cleanModel);
                            const activePresets = isGemini ? GEMINI_MODELS : OPENROUTER_MODELS;
                            setIsCustomModel(!activePresets.some(m => m.id === cleanModel));

                            try {
                                const start = Date.now();
                                const url = isGemini ? GOOGLE_GEMINI_API_URL : OPENROUTER_API_URL;
                                const headers: Record<string, string> = isGemini
                                    ? {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${keyToTest}`,
                                        'x-goog-api-key': keyToTest
                                    }
                                    : {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${keyToTest}`,
                                        'HTTP-Referer': 'https://aiha.app',
                                        'X-Title': 'Butler AI App'
                                    };
                                const payload: Record<string, any> = {
                                    model: cleanModel,
                                    messages: [{ role: 'user', content: 'Antwoord met precies één woord: OK' }],
                                    max_tokens: 64
                                };
                                if (supportsReasoningEffort(cleanModel)) {
                                    payload.reasoning_effort = 'low';
                                }

                                const res = await fetch(url, {
                                    method: 'POST',
                                    headers,
                                    body: JSON.stringify(payload)
                                });
                                const elapsed = Date.now() - start;

                                if (res.ok) {
                                    setTestResult({
                                        success: true,
                                        message: `✅ Verbinding geslaagd! ${cleanModel} via ${isGemini ? 'Google AI Studio' : 'OpenRouter'} reageerde in ${elapsed}ms.`
                                    });
                                } else {
                                    const err = await res.text();
                                    setTestResult({
                                        success: false,
                                        message: `❌ Fout (${res.status}): ${err.substring(0, 180)}`
                                    });
                                }
                            } catch (e: any) {
                                setTestResult({ success: false, message: `❌ Netwerkfout: ${e.message}` });
                            } finally {
                                setTestingKey(false);
                            }
                        }}
                        disabled={testingKey}
                        style={{
                            padding: '10px 14px',
                            borderRadius: '8px',
                            background: 'var(--bg-card, #1a1a24)',
                            border: '1px solid var(--border, #3a3a4a)',
                            color: 'var(--text-primary, #ffffff)',
                            fontWeight: 500,
                            cursor: testingKey ? 'wait' : 'pointer',
                            fontSize: '0.85rem'
                        }}
                    >
                        {testingKey ? '⏳ Testen...' : '🧪 Test Verbinding'}
                    </button>
                </div>

                {testResult && (
                    <div style={{
                        marginTop: '10px',
                        padding: '8px 10px',
                        borderRadius: '6px',
                        fontSize: '0.8rem',
                        background: testResult.success ? '#dcfce7' : '#fee2e2',
                        color: testResult.success ? '#15803d' : '#b91c1c'
                    }}>
                        {testResult.message}
                    </div>
                )}
            </div>

            {/* Proactive Backend Workers (On-Demand Control) */}
            <div style={{
                marginBottom: '24px',
                padding: '16px',
                background: 'rgba(16, 185, 129, 0.06)',
                borderRadius: '12px',
                border: '1px solid rgba(16, 185, 129, 0.22)'
            }}>
                <h3 style={{ margin: '0 0 6px 0' }}>🤖 Proactieve Butler Workers</h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '12px', lineHeight: '1.4' }}>
                    Alle proactieve achtergrondwerkers blijven automatisch draaien via de backend, en je kan elke worker hier (of via spraak/chat) direct handmatig starten.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {PROACTIVE_WORKERS.map((worker) => {
                        const isRunning = runningWorker === worker.id;
                        const st = workerStatus[worker.id];
                        return (
                            <div
                                key={worker.id}
                                style={{
                                    padding: '10px 12px',
                                    borderRadius: '8px',
                                    background: 'var(--bg-card, #1a1a24)',
                                    border: '1px solid var(--border, #3a3a4a)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '6px'
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                                            {worker.icon} {worker.name}
                                        </div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                                            {worker.description}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={!!runningWorker || !activeConnection?.id}
                                        onClick={async () => {
                                            if (!activeConnection?.id) return;
                                            setRunningWorker(worker.id);
                                            try {
                                                const res = await triggerProactiveWorker(worker.id, activeConnection.id);
                                                const summary = typeof res.data?.message === 'string'
                                                    ? res.data.message
                                                    : typeof res.data?.summary === 'string'
                                                        ? res.data.summary
                                                        : 'Voltooid';
                                                setWorkerStatus(prev => ({
                                                    ...prev,
                                                    [worker.id]: {
                                                        ok: res.success,
                                                        msg: res.success
                                                            ? `✅ ${summary} (${res.durationMs}ms)`
                                                            : `❌ ${res.error || 'Worker fout'}`
                                                    }
                                                }));
                                            } catch (err: any) {
                                                setWorkerStatus(prev => ({
                                                    ...prev,
                                                    [worker.id]: { ok: false, msg: `❌ ${err.message}` }
                                                }));
                                            } finally {
                                                setRunningWorker(null);
                                            }
                                        }}
                                        style={{
                                            padding: '6px 12px',
                                            borderRadius: '6px',
                                            background: isRunning ? '#4b5563' : '#059669',
                                            color: '#ffffff',
                                            border: 'none',
                                            fontSize: '0.78rem',
                                            fontWeight: 600,
                                            cursor: (!!runningWorker || !activeConnection?.id) ? 'not-allowed' : 'pointer',
                                            opacity: (!activeConnection?.id || (runningWorker && !isRunning)) ? 0.55 : 1,
                                            whiteSpace: 'nowrap'
                                        }}
                                    >
                                        {isRunning ? '⏳ Bezig...' : '▶ Start'}
                                    </button>
                                </div>
                                {st && (
                                    <div style={{
                                        fontSize: '0.75rem',
                                        padding: '4px 8px',
                                        borderRadius: '4px',
                                        background: st.ok ? 'rgba(22, 163, 74, 0.15)' : 'rgba(220, 38, 38, 0.15)',
                                        color: st.ok ? '#4ade80' : '#f87171'
                                    }}>
                                        {st.msg}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Floating Button Section */}
            <div style={{ marginBottom: '24px' }}>
                <h3 style={{ marginBottom: '12px' }}>🔵 Floating Button</h3>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                    Show a floating mic button on top of all apps
                </p>

                {/* Main Toggle */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                    <label className="toggle-switch">
                        <input
                            type="checkbox"
                            checked={floatingEnabled && !snoozeUntil}
                            onChange={handleToggle}
                        />
                        <span className="toggle-slider"></span>
                    </label>
                    <span>{floatingEnabled && !snoozeUntil ? 'Enabled' : snoozeUntil ? 'Snoozed' : 'Disabled'}</span>
                </div>

                {/* Snooze Status */}
                {snoozeUntil && (
                    <div style={{
                        background: 'rgba(255, 193, 7, 0.1)',
                        padding: '12px',
                        borderRadius: '8px',
                        marginBottom: '12px'
                    }}>
                        <p style={{ margin: 0, fontSize: '0.9rem' }}>
                            ⏸️ Snoozed — {formatSnoozeRemaining()}
                        </p>
                        <button
                            onClick={() => {
                                localStorage.removeItem('floatingButton.snoozeUntil');
                                setSnoozeUntil(null);
                                handleToggle();
                            }}
                            style={{ marginTop: '8px', padding: '4px 12px', fontSize: '0.85rem' }}
                        >
                            Resume Now
                        </button>
                    </div>
                )}

                {/* Snooze Options (only show when enabled) */}
                {floatingEnabled && !snoozeUntil && (
                    <div>
                        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                            Hide temporarily:
                        </p>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            <button onClick={() => handleSnooze(1)} style={{ padding: '6px 12px', fontSize: '0.85rem' }}>1 hour</button>
                            <button onClick={() => handleSnooze(4)} style={{ padding: '6px 12px', fontSize: '0.85rem' }}>4 hours</button>
                            <button onClick={handleSnoozeUntilTomorrow} style={{ padding: '6px 12px', fontSize: '0.85rem' }}>Until tomorrow</button>
                        </div>
                    </div>
                )}

                {/* Permission Warning */}
                {!hasPermission && (
                    <p style={{
                        fontSize: '0.85rem',
                        color: '#ef4444',
                        marginTop: '12px'
                    }}>
                        ⚠️ Overlay permission required. Tap the toggle to grant.
                    </p>
                )}
            </div>

            {/* Account Section */}
            <div style={{ marginBottom: '24px' }}>
                <h3 style={{ marginBottom: '12px' }}>👤 Account</h3>
                <button
                    onClick={async () => {
                        await signOut();
                        if (onClose) onClose();
                    }}
                    style={{
                        padding: '10px 16px',
                        fontSize: '0.9rem',
                        backgroundColor: '#fee2e2',
                        color: '#dc2626',
                        border: '1px solid #fecaca',
                        borderRadius: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        width: '100%',
                        cursor: 'pointer',
                        fontWeight: 500
                    }}
                >
                    Log Out
                </button>
            </div>

            {/* Voice Alerts Section */}
            <div style={{ marginBottom: '24px' }}>
                <h3 style={{ marginBottom: '12px' }}>📢 Voice Alerts</h3>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                    Butler speaks proactive suggestions and alerts aloud
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <label className="toggle-switch">
                        <input
                            type="checkbox"
                            checked={voiceAlertsEnabled}
                            onChange={() => {
                                const newValue = !voiceAlertsEnabled;
                                setVoiceAlertsEnabled(newValue);
                                localStorage.setItem('settings.voiceAlerts', String(newValue));
                            }}
                        />
                        <span className="toggle-slider"></span>
                    </label>
                    <span>{voiceAlertsEnabled ? 'Enabled' : 'Disabled'}</span>
                </div>
            </div>

            {/* Recommendation History Section */}
            <div style={{ marginBottom: '24px' }}>
                <h3 style={{ marginBottom: '12px' }}>🧠 Recommendation History</h3>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                    Butler learns from automations you ignore. Clearing this history resets that learning.
                </p>
                <button
                    onClick={async () => {
                        if (!activeConnection?.id) {
                            alert('No active connection found.');
                            return;
                        }
                        const confirmed = window.confirm(
                            'This will reset your AI learning for rejected automations.\n\n' +
                            'Butler will start suggesting these types of automations to you again.\n\n' +
                            'Are you sure you want to continue?'
                        );
                        if (!confirmed) return;

                        setClearingHistory(true);
                        try {
                            const { error } = await supabase
                                .from('suggestions')
                                .delete()
                                .eq('connection_id', activeConnection.id)
                                .eq('status', 'rejected');

                            // Also clear denied_proposals scoped to this connection
                            await supabase
                                .from('denied_proposals')
                                .delete()
                                .eq('connection_id', activeConnection.id);

                            if (error) {
                                alert('Failed to clear history: ' + error.message);
                            } else {
                                alert('✅ Recommendation history cleared!');
                            }
                        } catch (e: any) {
                            alert('Error: ' + e.message);
                        } finally {
                            setClearingHistory(false);
                        }
                    }}
                    disabled={clearingHistory}
                    style={{
                        padding: '10px 16px',
                        fontSize: '0.9rem',
                        backgroundColor: '#fef3c7',
                        color: '#92400e',
                        border: '1px solid #fcd34d',
                        borderRadius: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        width: '100%',
                        cursor: clearingHistory ? 'wait' : 'pointer',
                        fontWeight: 500,
                        opacity: clearingHistory ? 0.6 : 1
                    }}
                >
                    {clearingHistory ? '⏳ Clearing...' : '🗑️ Clear Rejected Proposals'}
                </button>
            </div>

            {/* Widget Info */}
            <div>
                <h3 style={{ marginBottom: '12px' }}>📱 Home Screen Widget</h3>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                    Add the Butler widget to your home screen for quick voice access.
                </p>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '8px' }}>
                    Long-press your home screen → Widgets → Butler
                </p>
            </div>
        </div>
    );
};
