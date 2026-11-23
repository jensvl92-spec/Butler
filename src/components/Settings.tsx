import React, { useState, useEffect } from 'react';
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { signOut, signInWithGoogle } from '../utils/auth';
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
import {
    getConnectedAccountsStatus,
    ConnectedAccountStatus
} from '../lib/services/googleWorkspaceService';
import {
    GEMINI_TTS_VOICES,
    DEEPGRAM_TTS_VOICES_NL,
    TTSProviderPreference,
    getTTSConfig,
    saveTTSConfig,
    synthesizeGeminiTTS,
    synthesizeDeepgramTTS
} from '../utils/speechUtils';
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
    const {
        activeConnection,
        entityStates,
        haDevices,
        haEntitiesRegistry,
        haSyncSource,
        haLastError,
        primaryApiUrl,
        fallbackApiUrl,
        resolvedApiUrl,
        saveFallbackApiUrl,
        refreshHAFromServer
    } = useApp();
    const [fallbackUrlInput, setFallbackUrlInput] = useState<string>(fallbackApiUrl || '');
    const [savingFallbackUrl, setSavingFallbackUrl] = useState<boolean>(false);
    const [fallbackUrlNotice, setFallbackUrlNotice] = useState<string | null>(null);
    useEffect(() => { setFallbackUrlInput(fallbackApiUrl || ''); }, [fallbackApiUrl]);
    const [floatingEnabled, setFloatingEnabled] = useState(false);
    const [hasPermission, setHasPermission] = useState(false);
    const [snoozeUntil, setSnoozeUntil] = useState<number | null>(null);
    const [voiceAlertsEnabled, setVoiceAlertsEnabled] = useState(true);
    const [clearingHistory, setClearingHistory] = useState(false);

    // Neural TTS Voice Settings
    const initialTts = getTTSConfig();
    const [ttsEnabled, setTtsEnabled] = useState<boolean>(initialTts.enabled);
    const [ttsProvider, setTtsProvider] = useState<TTSProviderPreference>(initialTts.provider);
    const [ttsGeminiVoice, setTtsGeminiVoice] = useState<string>(initialTts.geminiVoice);
    const [ttsDeepgramVoiceNl, setTtsDeepgramVoiceNl] = useState<string>(initialTts.deepgramVoiceNl);
    const [testingVoice, setTestingVoice] = useState<boolean>(false);
    const [voiceTestStatus, setVoiceTestStatus] = useState<string | null>(null);

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

    // Connected Personal Assistant Accounts (Google Workspace & Spotify)
    const emptyAccount: ConnectedAccountStatus = { connected: false, expired: false, hasRefreshToken: false, expiresAt: null };
    const [connectedAccounts, setConnectedAccounts] = useState<{ google: ConnectedAccountStatus; spotify: ConnectedAccountStatus }>({
        google: emptyAccount,
        spotify: emptyAccount
    });
    const [linkingProvider, setLinkingProvider] = useState<'google' | 'spotify' | null>(null);
    const [accountNotice, setAccountNotice] = useState<string | null>(null);

    const refreshConnectedAccounts = async () => {
        try {
            const status = await getConnectedAccountsStatus();
            setConnectedAccounts(status);
        } catch { }
    };

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
        refreshConnectedAccounts();

        const onVisChange = () => {
            if (document.visibilityState === 'visible') {
                checkPermission();
                refreshConnectedAccounts();
            }
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

            {/* Connected Accounts Section (Google Workspace & Spotify) */}
            <div style={{
                marginBottom: '24px',
                padding: '16px',
                background: 'rgba(16, 185, 129, 0.07)',
                borderRadius: '12px',
                border: '1px solid rgba(16, 185, 129, 0.25)'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                        🔗 Gekoppelde Accounts
                    </h3>
                    <button
                        type="button"
                        onClick={refreshConnectedAccounts}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: '#6ee7b7',
                            fontSize: '0.75rem',
                            cursor: 'pointer',
                            textDecoration: 'underline'
                        }}
                    >
                        ↻ Vernieuw status
                    </button>
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '12px', lineHeight: '1.4' }}>
                    Koppel Google voor Agenda, Docs, Sheets, Tasks, Gmail en YouTube — en Spotify voor directe muziekbediening.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {/* Google Workspace Row */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                        padding: '10px 12px',
                        borderRadius: '10px',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.09)'
                    }}>
                        <div>
                            <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary, #ffffff)' }}>
                                📆 Google Workspace
                            </div>
                            <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary, #9ca3af)' }}>
                                Agenda, Docs, Sheets, Tasks, Gmail & YouTube
                            </div>
                            <span style={{
                                display: 'inline-block',
                                marginTop: '4px',
                                fontSize: '0.7rem',
                                fontWeight: 700,
                                padding: '2px 7px',
                                borderRadius: '999px',
                                background: connectedAccounts.google.connected
                                    ? (connectedAccounts.google.expired ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)')
                                    : 'rgba(148, 163, 184, 0.16)',
                                color: connectedAccounts.google.connected
                                    ? (connectedAccounts.google.expired ? '#fbbf24' : '#34d399')
                                    : '#cbd5e1'
                            }}>
                                {connectedAccounts.google.connected
                                    ? (connectedAccounts.google.expired ? '🟡 Verlopen — tik om te vernieuwen' : '🟢 Verbonden')
                                    : '⚪ Niet gekoppeld'}
                            </span>
                        </div>
                        <button
                            type="button"
                            disabled={linkingProvider !== null}
                            onClick={async () => {
                                setLinkingProvider('google');
                                setAccountNotice(null);
                                try {
                                    const { error } = await signInWithGoogle();
                                    if (error) {
                                        setAccountNotice(`❌ Google koppelen mislukt: ${error.message}`);
                                    } else {
                                        setAccountNotice('✅ Google-inlogscherm geopend. Na toestemming wordt de koppeling automatisch actief.');
                                    }
                                } catch (e: any) {
                                    setAccountNotice(`❌ Fout bij Google koppelen: ${e?.message || e}`);
                                } finally {
                                    setLinkingProvider(null);
                                }
                            }}
                            style={{
                                padding: '8px 12px',
                                borderRadius: '8px',
                                border: 'none',
                                background: '#4f46e5',
                                color: '#ffffff',
                                fontWeight: 700,
                                fontSize: '0.78rem',
                                cursor: linkingProvider ? 'wait' : 'pointer',
                                whiteSpace: 'nowrap'
                            }}
                        >
                            {linkingProvider === 'google'
                                ? '⏳ ...'
                                : (connectedAccounts.google.connected ? '↻ Vernieuw Google' : '🔗 Koppel Google')}
                        </button>
                    </div>

                    {/* Spotify Row */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                        padding: '10px 12px',
                        borderRadius: '10px',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.09)'
                    }}>
                        <div>
                            <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary, #ffffff)' }}>
                                🎵 Spotify
                            </div>
                            <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary, #9ca3af)' }}>
                                Afspelen, pauzeren, nummers kiezen & volume
                            </div>
                            <span style={{
                                display: 'inline-block',
                                marginTop: '4px',
                                fontSize: '0.7rem',
                                fontWeight: 700,
                                padding: '2px 7px',
                                borderRadius: '999px',
                                background: connectedAccounts.spotify.connected
                                    ? (connectedAccounts.spotify.expired ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)')
                                    : 'rgba(148, 163, 184, 0.16)',
                                color: connectedAccounts.spotify.connected
                                    ? (connectedAccounts.spotify.expired ? '#fbbf24' : '#34d399')
                                    : '#cbd5e1'
                            }}>
                                {connectedAccounts.spotify.connected
                                    ? (connectedAccounts.spotify.expired ? '🟡 Verlopen — tik om te vernieuwen' : '🟢 Verbonden')
                                    : '⚪ Niet gekoppeld (app-fallback actief)'}
                            </span>
                        </div>
                        <button
                            type="button"
                            disabled={linkingProvider !== null}
                            onClick={async () => {
                                setLinkingProvider('spotify');
                                setAccountNotice(null);
                                try {
                                    const sbUrl = ((import.meta as any).env?.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
                                    const sbAnon = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || '';
                                    const { data: sessionData } = await supabase.auth.getSession();
                                    const jwt = sessionData?.session?.access_token;
                                    if (!sbUrl || !jwt) {
                                        setAccountNotice('⚠️ Log eerst in met je account om Spotify te koppelen.');
                                        return;
                                    }

                                    const initEndpoint = `${sbUrl}/functions/v1/auth-spotify-init`;
                                    const authHeaders: Record<string, string> = {
                                        Authorization: `Bearer ${jwt}`,
                                        ...(sbAnon ? { apikey: sbAnon } : {})
                                    };

                                    let spotifyAuthUrl = '';

                                    if (Capacitor.isNativePlatform()) {
                                        // Call auth-spotify-init with Bearer JWT header (passes Supabase verify_jwt=true gateway!)
                                        // and capture the 302 Location redirect directly without opening an unauthenticated URL in Chrome.
                                        const res = await CapacitorHttp.get({
                                            url: initEndpoint,
                                            headers: authHeaders,
                                            disableRedirects: true,
                                            connectTimeout: 10000,
                                            readTimeout: 10000
                                        });

                                        const hdrs = res.headers || {};
                                        const locHeader = hdrs.Location || hdrs.location || Object.entries(hdrs).find(([k]) => k.toLowerCase() === 'location')?.[1] || '';
                                        const jsonUrl = typeof res.data === 'object' && res.data?.url ? String(res.data.url) : '';
                                        const finalUrl = typeof res.url === 'string' && res.url.startsWith('https://accounts.spotify.com/') ? res.url : '';
                                        spotifyAuthUrl = String(locHeader || jsonUrl || finalUrl || '').trim();

                                        if (!spotifyAuthUrl) {
                                            const errDetail = typeof res.data === 'object'
                                                ? (res.data?.error || res.data?.message || JSON.stringify(res.data))
                                                : String(res.data || `HTTP ${res.status}`);
                                            throw new Error(`Kon Spotify-login niet starten (${res.status}): ${errDetail}`);
                                        }
                                    } else {
                                        const res = await fetch(`${initEndpoint}?format=json`, {
                                            method: 'GET',
                                            headers: authHeaders,
                                            redirect: 'manual'
                                        });
                                        const locHeader = res.headers.get('location') || '';
                                        if (locHeader) {
                                            spotifyAuthUrl = locHeader;
                                        } else if (res.ok) {
                                            const body = await res.json().catch(() => null);
                                            spotifyAuthUrl = body?.url || '';
                                        } else {
                                            const txt = await res.text().catch(() => '');
                                            throw new Error(`HTTP ${res.status}: ${txt}`);
                                        }
                                    }

                                    if (!spotifyAuthUrl.startsWith('https://accounts.spotify.com/')) {
                                        throw new Error(`Ongeldige Spotify URL ontvangen: ${spotifyAuthUrl.slice(0, 80)}`);
                                    }

                                    const parsedSpotify = new URL(spotifyAuthUrl);
                                    if (!parsedSpotify.searchParams.get('client_id')) {
                                        throw new Error('SPOTIFY_CLIENT_ID ontbreekt in je Supabase Edge Function secrets.');
                                    }

                                    if (Capacitor.isNativePlatform()) {
                                        const finishListener = await Browser.addListener('browserFinished', () => {
                                            refreshConnectedAccounts();
                                            finishListener.remove().catch(() => {});
                                        });
                                        await Browser.open({ url: spotifyAuthUrl });
                                    } else {
                                        window.open(spotifyAuthUrl, '_blank', 'noopener,noreferrer');
                                    }
                                    setAccountNotice('✅ Spotify-inlogscherm geopend. Sluit na akkoord het venster om terug te keren naar Butler.');
                                } catch (e: any) {
                                    setAccountNotice(`❌ Fout bij Spotify koppelen: ${e?.message || e}`);
                                } finally {
                                    setLinkingProvider(null);
                                }
                            }}
                            style={{
                                padding: '8px 12px',
                                borderRadius: '8px',
                                border: 'none',
                                background: '#16a34a',
                                color: '#ffffff',
                                fontWeight: 700,
                                fontSize: '0.78rem',
                                cursor: linkingProvider ? 'wait' : 'pointer',
                                whiteSpace: 'nowrap'
                            }}
                        >
                            {linkingProvider === 'spotify'
                                ? '⏳ ...'
                                : (connectedAccounts.spotify.connected ? '↻ Vernieuw Spotify' : '🎵 Koppel Spotify')}
                        </button>
                    </div>
                </div>

                {accountNotice && (
                    <p style={{ margin: '10px 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        {accountNotice}
                    </p>
                )}
            </div>

            {/* Home Assistant Integrations & Sync Diagnostics */}
            {activeConnection && (() => {
                const entityCount = Object.keys(entityStates || {}).length;
                const devById = new Map<string, any>();
                (haDevices || []).forEach((d: any) => { if (d?.id) devById.set(d.id, d); });

                const integrationMap = new Map<string, { name: string; entities: number; deviceIds: Set<string> }>();
                (haEntitiesRegistry || []).forEach((e: any) => {
                    if (!e?.entity_id || e.disabled_by || e.hidden_by) return;
                    const dev = e.device_id ? devById.get(e.device_id) : null;
                    const identPlat = Array.isArray(dev?.identifiers) && Array.isArray(dev.identifiers[0])
                        ? dev.identifiers[0][0]
                        : '';
                    const plat = (e.platform || dev?.platform || identPlat || '').toLowerCase().trim();
                    if (!plat) return;
                    if (!integrationMap.has(plat)) {
                        integrationMap.set(plat, { name: plat, entities: 0, deviceIds: new Set() });
                    }
                    const entry = integrationMap.get(plat)!;
                    entry.entities += 1;
                    if (e.device_id) entry.deviceIds.add(e.device_id);
                });

                const integrations = Array.from(integrationMap.values()).sort((a, b) => b.entities - a.entities);
                const syncBadge =
                    haSyncSource === 'websocket' ? { text: '🟢 Live (WS)', bg: '#dcfce7', color: '#15803d' } :
                    haSyncSource === 'rest' ? { text: '🔵 Live (REST)', bg: '#dbeafe', color: '#1d4ed8' } :
                    haSyncSource === 'cache' ? { text: '🟠 Offline (cache)', bg: '#fef3c7', color: '#92400e' } :
                    { text: '⚪ Wachten...', bg: '#e5e7eb', color: '#374151' };

                const handleSaveFallbackUrl = async () => {
                    setSavingFallbackUrl(true);
                    setFallbackUrlNotice(null);
                    try {
                        saveFallbackApiUrl(fallbackUrlInput);
                        const res = await refreshHAFromServer();
                        if (res.error) {
                            setFallbackUrlNotice(`Opgeslagen, maar HA reageert nog niet: ${res.error}`);
                        } else {
                            setFallbackUrlNotice(`✅ Opgeslagen & live verbonden (${res.source === 'websocket' ? 'WS' : 'REST'})!`);
                        }
                    } catch (e: any) {
                        setFallbackUrlNotice(`❌ ${e?.message || 'Opslaan mislukt'}`);
                    } finally {
                        setSavingFallbackUrl(false);
                    }
                };

                return (
                    <div style={{
                        marginBottom: '24px',
                        padding: '16px',
                        background: 'rgba(59, 130, 246, 0.07)',
                        borderRadius: '12px',
                        border: '1px solid rgba(59, 130, 246, 0.25)'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', gap: '8px' }}>
                            <h3 style={{ margin: 0 }}>🔌 Home Assistant Verbinding</h3>
                            <span style={{
                                fontSize: '0.72rem',
                                fontWeight: 600,
                                padding: '2px 8px',
                                borderRadius: '999px',
                                background: syncBadge.bg,
                                color: syncBadge.color,
                                whiteSpace: 'nowrap'
                            }}>
                                {syncBadge.text}
                            </span>
                        </div>
                        <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '8px', lineHeight: 1.4 }}>
                            <strong>{entityCount}</strong> entiteiten • <strong>{haDevices?.length || 0}</strong> apparaten • <strong>{integrations.length}</strong> integraties
                            {resolvedApiUrl && (
                                <>
                                    <br />
                                    <span style={{ fontSize: '0.74rem', opacity: 0.85 }}>Actieve URL: <code>{resolvedApiUrl}</code></span>
                                </>
                            )}
                        </p>
                        {haSyncSource === 'cache' && haLastError && (
                            <div style={{
                                marginBottom: '10px',
                                padding: '8px 10px',
                                borderRadius: '8px',
                                background: 'rgba(245, 158, 11, 0.14)',
                                border: '1px solid rgba(245, 158, 11, 0.35)',
                                fontSize: '0.75rem',
                                color: '#fde68a'
                            }}>
                                ⚠️ {haLastError}
                            </div>
                        )}

                        {/* Dual-URL Auto-Failover (Local Wi-Fi <-> Tailscale/External) */}
                        <div style={{
                            marginBottom: '12px',
                            padding: '10px',
                            borderRadius: '10px',
                            background: 'rgba(255, 255, 255, 0.04)',
                            border: '1px solid rgba(255, 255, 255, 0.08)'
                        }}>
                            <div style={{ fontSize: '0.76rem', fontWeight: 600, marginBottom: '4px' }}>
                                🔄 2e URL voor Wi-Fi ↔ Tailscale auto-switch (optioneel)
                            </div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: '8px', lineHeight: 1.35 }}>
                                Hoofd-URL: <code>{primaryApiUrl || '—'}</code>. Vul hier je tweede adres in (bv. lokale Wi-Fi <code>http://192.168.x.x:8123</code> of externe Tailscale <code>https://...ts.net</code>), dan schakelt Butler automatisch om net zoals de Home Assistant app.
                            </div>
                            <div style={{ display: 'flex', gap: '6px' }}>
                                <input
                                    type="url"
                                    value={fallbackUrlInput}
                                    onChange={(e) => setFallbackUrlInput(e.target.value)}
                                    placeholder={/^http:\/\//i.test(primaryApiUrl) ? 'https://jouw-ha.tailxxxx.ts.net' : 'http://192.168.1.x:8123'}
                                    style={{
                                        flex: 1,
                                        minWidth: 0,
                                        padding: '7px 10px',
                                        borderRadius: '8px',
                                        border: '1px solid var(--border, rgba(255,255,255,0.14))',
                                        background: 'rgba(0,0,0,0.2)',
                                        color: 'var(--text-primary, #fff)',
                                        fontSize: '0.78rem'
                                    }}
                                />
                                <button
                                    type="button"
                                    disabled={savingFallbackUrl}
                                    onClick={handleSaveFallbackUrl}
                                    style={{
                                        padding: '7px 12px',
                                        borderRadius: '8px',
                                        border: 'none',
                                        background: '#4f46e5',
                                        color: '#ffffff',
                                        fontSize: '0.76rem',
                                        fontWeight: 600,
                                        cursor: savingFallbackUrl ? 'wait' : 'pointer',
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    {savingFallbackUrl ? 'Testen...' : 'Opslaan'}
                                </button>
                            </div>
                            {fallbackUrlNotice && (
                                <div style={{ fontSize: '0.72rem', marginTop: '6px', color: fallbackUrlNotice.startsWith('✅') ? '#6ee7b7' : '#fde68a' }}>
                                    {fallbackUrlNotice}
                                </div>
                            )}
                        </div>
                        {integrations.length > 0 ? (
                            <div style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: '6px',
                                maxHeight: '140px',
                                overflowY: 'auto',
                                padding: '4px 0'
                            }}>
                                {integrations.map((intg) => (
                                    <span
                                        key={intg.name}
                                        style={{
                                            fontSize: '0.74rem',
                                            padding: '4px 9px',
                                            borderRadius: '999px',
                                            background: intg.name.includes('localthings')
                                                ? 'rgba(16, 185, 129, 0.22)'
                                                : 'rgba(255, 255, 255, 0.06)',
                                            border: intg.name.includes('localthings')
                                                ? '1px solid rgba(16, 185, 129, 0.5)'
                                                : '1px solid var(--border, rgba(255,255,255,0.12))',
                                            color: intg.name.includes('localthings') ? '#6ee7b7' : 'var(--text-primary, #ffffff)',
                                            fontWeight: intg.name.includes('localthings') ? 600 : 500
                                        }}
                                    >
                                        {intg.name} ({intg.deviceIds.size > 0 ? `${intg.deviceIds.size} app · ` : ''}{intg.entities})
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: 0 }}>
                                Integratie-metadata wordt opgehaald vanuit Home Assistant...
                            </p>
                        )}
                    </div>
                );
            })()}

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

            {/* Neural Voice & TTS Section */}
            <div style={{
                marginBottom: '24px',
                padding: '16px',
                background: 'rgba(16, 185, 129, 0.08)',
                borderRadius: '12px',
                border: '1px solid rgba(16, 185, 129, 0.25)'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <h3 style={{ margin: 0 }}>🗣️ Stem & Spraak (Neural TTS)</h3>
                    <label className="toggle-switch">
                        <input
                            type="checkbox"
                            checked={ttsEnabled}
                            onChange={() => {
                                const next = !ttsEnabled;
                                setTtsEnabled(next);
                                saveTTSConfig({ enabled: next });
                            }}
                        />
                        <span className="toggle-slider"></span>
                    </label>
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '12px', lineHeight: 1.4 }}>
                    Butler spreekt antwoorden uit met een natuurlijke AI-stem (zonder sterretjes of opmaaktekens voor te lezen).
                </p>

                {ttsEnabled && (
                    <>
                        <div style={{ marginBottom: '10px' }}>
                            <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: '4px', color: 'var(--text-primary, #ffffff)' }}>
                                Stem-engine
                            </label>
                            <select
                                value={ttsProvider}
                                onChange={(e) => {
                                    const val = e.target.value as TTSProviderPreference;
                                    setTtsProvider(val);
                                    saveTTSConfig({ provider: val });
                                }}
                                style={{
                                    width: '100%',
                                    padding: '9px 12px',
                                    borderRadius: '8px',
                                    border: '1px solid var(--border, #3a3a4a)',
                                    background: 'var(--bg-elevated, #252532)',
                                    color: 'var(--text-primary, #ffffff)',
                                    fontSize: '0.84rem'
                                }}
                            >
                                <option value="auto" style={{ background: '#1a1a24', color: '#ffffff' }}>
                                    ✨ Automatisch (Gemini Neural → Deepgram Aura-2 → Android)
                                </option>
                                <option value="gemini" style={{ background: '#1a1a24', color: '#ffffff' }}>
                                    🔵 Google Gemini Neural (Studio Nederlands/Vlaams)
                                </option>
                                <option value="deepgram" style={{ background: '#1a1a24', color: '#ffffff' }}>
                                    🟢 Deepgram Aura-2 (Ultrasnel Nederlands)
                                </option>
                                <option value="native" style={{ background: '#1a1a24', color: '#ffffff' }}>
                                    📱 Apparaatstem (Offline, beste Android stem)
                                </option>
                            </select>
                        </div>

                        {(ttsProvider === 'auto' || ttsProvider === 'gemini') && (
                            <div style={{ marginBottom: '10px' }}>
                                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: '4px', color: 'var(--text-primary, #ffffff)' }}>
                                    Gemini Studio Stem
                                </label>
                                <select
                                    value={ttsGeminiVoice}
                                    onChange={(e) => {
                                        setTtsGeminiVoice(e.target.value);
                                        saveTTSConfig({ geminiVoice: e.target.value });
                                    }}
                                    style={{
                                        width: '100%',
                                        padding: '9px 12px',
                                        borderRadius: '8px',
                                        border: '1px solid var(--border, #3a3a4a)',
                                        background: 'var(--bg-elevated, #252532)',
                                        color: 'var(--text-primary, #ffffff)',
                                        fontSize: '0.84rem'
                                    }}
                                >
                                    {GEMINI_TTS_VOICES.map((v) => (
                                        <option key={v.id} value={v.id} style={{ background: '#1a1a24', color: '#ffffff' }}>
                                            {v.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {(ttsProvider === 'auto' || ttsProvider === 'deepgram') && (
                            <div style={{ marginBottom: '12px' }}>
                                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: '4px', color: 'var(--text-primary, #ffffff)' }}>
                                    Deepgram Aura-2 Nederlandse Stem
                                </label>
                                <select
                                    value={ttsDeepgramVoiceNl}
                                    onChange={(e) => {
                                        setTtsDeepgramVoiceNl(e.target.value);
                                        saveTTSConfig({ deepgramVoiceNl: e.target.value });
                                    }}
                                    style={{
                                        width: '100%',
                                        padding: '9px 12px',
                                        borderRadius: '8px',
                                        border: '1px solid var(--border, #3a3a4a)',
                                        background: 'var(--bg-elevated, #252532)',
                                        color: 'var(--text-primary, #ffffff)',
                                        fontSize: '0.84rem'
                                    }}
                                >
                                    {DEEPGRAM_TTS_VOICES_NL.map((v) => (
                                        <option key={v.id} value={v.id} style={{ background: '#1a1a24', color: '#ffffff' }}>
                                            {v.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <button
                            type="button"
                            disabled={testingVoice}
                            onClick={async () => {
                                setTestingVoice(true);
                                setVoiceTestStatus(null);
                                const sample = 'Hallo, ik ben Butler. Mijn stem klinkt nu een stuk natuurlijker en ik lees geen sterretjes meer voor.';
                                try {
                                    const gKey = (localStorage.getItem('butler.gemini_api_key') || (import.meta as any).env?.VITE_GEMINI_API_KEY || '').trim();
                                    let blob: Blob | null = null;
                                    let usedEngine = '';

                                    if ((ttsProvider === 'auto' || ttsProvider === 'gemini') && gKey) {
                                        const res = await synthesizeGeminiTTS(sample, gKey, ttsGeminiVoice, { language: 'nl-BE' });
                                        if (res) {
                                            blob = res.blob;
                                            usedEngine = `Gemini (${ttsGeminiVoice})`;
                                        }
                                    }

                                    if (!blob && (ttsProvider === 'auto' || ttsProvider === 'deepgram')) {
                                        const sbUrl = (import.meta as any).env?.VITE_SUPABASE_URL || '';
                                        const { data: sessionData } = await supabase.auth.getSession();
                                        const jwt = sessionData?.session?.access_token;
                                        if (sbUrl && jwt) {
                                            const res = await synthesizeDeepgramTTS(sample, sbUrl, jwt, 'nl-BE', ttsDeepgramVoiceNl);
                                            if (res) {
                                                blob = res.blob;
                                                usedEngine = `Deepgram (${res.voice})`;
                                            }
                                        }
                                    }

                                    if (blob) {
                                        const url = URL.createObjectURL(blob);
                                        const audio = new Audio(url);
                                        audio.onended = () => URL.revokeObjectURL(url);
                                        await audio.play();
                                        setVoiceTestStatus(`✅ Actief via ${usedEngine}`);
                                    } else {
                                        setVoiceTestStatus('ℹ️ Cloud-stem niet bereikbaar — apparaatstem wordt gebruikt.');
                                    }
                                } catch (err: any) {
                                    setVoiceTestStatus(`⚠️ Test mislukt: ${err?.message || 'Onbekende fout'}`);
                                } finally {
                                    setTestingVoice(false);
                                }
                            }}
                            style={{
                                width: '100%',
                                padding: '9px 12px',
                                borderRadius: '8px',
                                background: 'rgba(16, 185, 129, 0.2)',
                                color: '#6ee7b7',
                                border: '1px solid rgba(16, 185, 129, 0.4)',
                                fontWeight: 600,
                                cursor: testingVoice ? 'wait' : 'pointer',
                                fontSize: '0.84rem'
                            }}
                        >
                            {testingVoice ? '⏳ Stem genereren...' : '🔊 Test Stem'}
                        </button>
                        {voiceTestStatus && (
                            <p style={{ margin: '8px 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                {voiceTestStatus}
                            </p>
                        )}
                    </>
                )}
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
