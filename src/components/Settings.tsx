import React, { useState, useEffect } from 'react';
import { registerPlugin } from '@capacitor/core';
import { signOut } from '../utils/auth';
import { supabase } from '../lib/supabase';
import { useApp } from '../lib/AppContext';
import { sanitizeModelId } from '../lib/services/clientOrchestrator';

// @ts-ignore
import { logger } from '../utils/logger';

// Define the FloatingButton plugin interface
interface FloatingButtonPlugin {
    start(): Promise<{ started: boolean }>;
    stop(): Promise<{ stopped: boolean }>;
    hasOverlayPermission(): Promise<{ hasPermission: boolean }>;
    requestOverlayPermission(): Promise<void>;
    checkPendingVoiceInput(): Promise<{ pending: boolean }>;
}

const FloatingButton = registerPlugin<FloatingButtonPlugin>('FloatingButton');

interface SettingsProps {
    onClose?: () => void;
}

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
    const { activeConnection } = useApp();
    const [floatingEnabled, setFloatingEnabled] = useState(false);
    const [hasPermission, setHasPermission] = useState(false);
    const [snoozeUntil, setSnoozeUntil] = useState<number | null>(null);
    const [voiceAlertsEnabled, setVoiceAlertsEnabled] = useState(true);  // Proactive voice alerts
    const [clearingHistory, setClearingHistory] = useState(false);

    // AI Brain Settings (Client-Side Google Gemini / OpenRouter)
    const [aiProvider, setAiProvider] = useState<'gemini' | 'openrouter'>('gemini');
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [llmModel, setLlmModel] = useState('gemini-3-flash-preview');
    const [showApiKey, setShowApiKey] = useState(false);
    const [testingKey, setTestingKey] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [keySaved, setKeySaved] = useState(false);

    // Load settings from localStorage
    useEffect(() => {
        const savedEnabled = localStorage.getItem('floatingButton.enabled') === 'true';
        const savedSnooze = localStorage.getItem('floatingButton.snoozeUntil');

        const savedProvider = (localStorage.getItem('butler.ai_provider') as 'gemini' | 'openrouter') || 'gemini';
        setAiProvider(savedProvider);

        const geminiKey = localStorage.getItem('butler.gemini_api_key') || (import.meta as any).env?.VITE_GEMINI_API_KEY || '';
        const openRouterKey = localStorage.getItem('butler.openrouter_api_key') || (import.meta as any).env?.VITE_OPENROUTER_API_KEY || '';
        const initialKey = savedProvider === 'gemini' ? (geminiKey || openRouterKey) : (openRouterKey || geminiKey);
        setApiKeyInput(initialKey);

        const savedModelRaw = localStorage.getItem('butler.llm_model') || (savedProvider === 'gemini' ? 'gemini-3-flash-preview' : 'google/gemini-3-flash-preview');
        const cleanSavedModel = sanitizeModelId(savedModelRaw, savedProvider);
        setLlmModel(cleanSavedModel);

        if (savedSnooze) {
            const snoozeTime = parseInt(savedSnooze, 10);
            if (snoozeTime > Date.now()) {
                setSnoozeUntil(snoozeTime);
                setFloatingEnabled(false);
            } else {
                // Snooze expired
                localStorage.removeItem('floatingButton.snoozeUntil');
                setFloatingEnabled(savedEnabled);
            }
        } else {
            setFloatingEnabled(savedEnabled);
        }

        // Check permission
        checkPermission();

        // Load voice alerts setting
        const savedVoiceAlerts = localStorage.getItem('settings.voiceAlerts');
        if (savedVoiceAlerts !== null) {
            setVoiceAlertsEnabled(savedVoiceAlerts === 'true');
        }
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
                            setLlmModel('gemini-3-flash-preview');
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
                            setLlmModel('google/gemini-3-flash-preview');
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
                        value={llmModel}
                        onChange={(e) => setLlmModel(e.target.value)}
                        style={{
                            width: '100%',
                            padding: '10px 12px',
                            borderRadius: '8px',
                            border: '1px solid var(--border, #3a3a4a)',
                            background: 'var(--bg-elevated, #252532)',
                            color: 'var(--text-primary, #ffffff)',
                            fontSize: '0.85rem',
                            outline: 'none'
                        }}
                    >
                        {aiProvider === 'gemini' ? (
                            <>
                                <option value="gemini-3-flash-preview" style={{ background: '#1a1a24', color: '#ffffff' }}>gemini-3-flash-preview (Aanbevolen: snel, voordelig & topkwaliteit)</option>
                                <option value="gemini-3.8-flash" style={{ background: '#1a1a24', color: '#ffffff' }}>gemini-3.8-flash (Extreem krachtig & snel)</option>
                                <option value="gemini-3.1-pro" style={{ background: '#1a1a24', color: '#ffffff' }}>gemini-3.1-pro (Diep redeneren)</option>
                                <option value="gemini-2.5-flash" style={{ background: '#1a1a24', color: '#ffffff' }}>gemini-2.5-flash (Betrouwbaar werkpaard)</option>
                            </>
                        ) : (
                            <>
                                <option value="google/gemini-3-flash-preview" style={{ background: '#1a1a24', color: '#ffffff' }}>google/gemini-3-flash-preview (Aanbevolen)</option>
                                <option value="google/gemini-3.8-flash" style={{ background: '#1a1a24', color: '#ffffff' }}>google/gemini-3.8-flash</option>
                                <option value="google/gemini-3.1-pro" style={{ background: '#1a1a24', color: '#ffffff' }}>google/gemini-3.1-pro</option>
                                <option value="google/gemini-2.5-flash" style={{ background: '#1a1a24', color: '#ffffff' }}>google/gemini-2.5-flash</option>
                            </>
                        )}
                    </select>
                    <div style={{ marginTop: '8px' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #9ca3af)' }}>
                            Exact Model ID (aanpasbaar):
                        </span>
                        <input
                            type="text"
                            value={llmModel}
                            onChange={(e) => setLlmModel(e.target.value)}
                            onBlur={() => setLlmModel(prev => sanitizeModelId(prev, aiProvider))}
                            placeholder={aiProvider === 'gemini' ? 'gemini-3-flash-preview' : 'google/gemini-3-flash-preview'}
                            style={{
                                width: '100%',
                                marginTop: '4px',
                                padding: '10px 12px',
                                borderRadius: '8px',
                                border: '1px solid var(--border, #3a3a4a)',
                                background: 'var(--bg-elevated, #252532)',
                                color: 'var(--text-primary, #ffffff)',
                                caretColor: '#6366f1',
                                fontSize: '0.9rem',
                                fontFamily: 'monospace',
                                outline: 'none'
                            }}
                        />
                    </div>
                </div>

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
                                    setLlmModel('gemini-3-flash-preview');
                                } else if (val.startsWith('sk-or-') && aiProvider !== 'openrouter') {
                                    setAiProvider('openrouter');
                                    setLlmModel('google/gemini-3-flash-preview');
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
                            const isGemini = aiProvider === 'gemini' || trimmed.startsWith('AIzaSy');
                            const cleanModel = sanitizeModelId(llmModel, isGemini ? 'gemini' : 'openrouter');
                            setLlmModel(cleanModel);
                            if (isGemini) {
                                localStorage.setItem('butler.gemini_api_key', trimmed);
                                localStorage.setItem('butler.ai_provider', 'gemini');
                            } else {
                                localStorage.setItem('butler.openrouter_api_key', trimmed);
                                localStorage.setItem('butler.ai_provider', 'openrouter');
                            }
                            localStorage.setItem('butler.api_key', trimmed);
                            localStorage.setItem('butler.llm_model', cleanModel);
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
                            const isGemini = aiProvider === 'gemini' || trimmed.startsWith('AIzaSy');
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

                            const cleanModel = sanitizeModelId(llmModel, isGemini ? 'gemini' : 'openrouter');
                            setLlmModel(cleanModel);

                            try {
                                const start = Date.now();
                                if (isGemini) {
                                    // 1. Google AI Studio OpenAI-compatible endpoint
                                    const openaiRes = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'Authorization': `Bearer ${keyToTest}`,
                                            'x-goog-api-key': keyToTest
                                        },
                                        body: JSON.stringify({
                                            model: cleanModel,
                                            messages: [{ role: 'user', content: 'Ping' }],
                                            max_tokens: 10
                                        })
                                    });

                                    const elapsed = Date.now() - start;

                                    if (openaiRes.ok) {
                                        setTestResult({
                                            success: true,
                                            message: `✅ Verbinding geslaagd! ${cleanModel} via Google AI Studio reageerde in ${elapsed}ms.`
                                        });
                                    } else {
                                        // 2. Direct Gemini REST endpoint fallback verification
                                        let directOk = false;
                                        try {
                                            const directRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${keyToTest}`, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({
                                                    contents: [{ parts: [{ text: 'Ping' }] }],
                                                    generationConfig: { maxOutputTokens: 10 }
                                                })
                                            });
                                            if (directRes.ok) {
                                                directOk = true;
                                            }
                                        } catch {
                                            directOk = false;
                                        }

                                        if (directOk) {
                                            setTestResult({
                                                success: true,
                                                message: `✅ Verbinding geslaagd! ${cleanModel} geverifieerd via Google Gemini API in ${elapsed}ms.`
                                            });
                                        } else {
                                            const err = await openaiRes.text();
                                            setTestResult({
                                                success: false,
                                                message: `❌ Fout (${openaiRes.status}): ${err.substring(0, 160)}`
                                            });
                                        }
                                    }
                                } else {
                                    // OpenRouter
                                    const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'Authorization': `Bearer ${keyToTest}`,
                                            'HTTP-Referer': 'https://aiha.app',
                                            'X-Title': 'Butler AI App'
                                        },
                                        body: JSON.stringify({
                                            model: cleanModel,
                                            messages: [{ role: 'user', content: 'Ping' }],
                                            max_tokens: 10
                                        })
                                    });
                                    const elapsed = Date.now() - start;
                                    if (openRouterRes.ok) {
                                        setTestResult({
                                            success: true,
                                            message: `✅ Verbinding geslaagd! ${cleanModel} via OpenRouter reageerde in ${elapsed}ms.`
                                        });
                                    } else {
                                        const err = await openRouterRes.text();
                                        setTestResult({
                                            success: false,
                                            message: `❌ Fout (${openRouterRes.status}): ${err.substring(0, 160)}`
                                        });
                                    }
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
                        // App state listener handles redirect to Auth screen
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
                            const { error, count } = await supabase
                                .from('suggestions')
                                .delete()
                                .or(`connection_id.eq.${activeConnection.id},connection_id.is.null`)
                                .eq('status', 'rejected');

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
