import React, { useState, useEffect } from 'react';
import { registerPlugin } from '@capacitor/core';
import { signOut } from '../utils/auth';
import { supabase } from '../lib/supabase';
import { useApp } from '../lib/AppContext';

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

    // Load settings from localStorage
    useEffect(() => {
        const savedEnabled = localStorage.getItem('floatingButton.enabled') === 'true';
        const savedSnooze = localStorage.getItem('floatingButton.snoozeUntil');

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
                                .eq('connection_id', activeConnection.id)
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
