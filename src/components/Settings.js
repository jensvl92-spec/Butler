import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { registerPlugin } from '@capacitor/core';
import { signOut } from '../utils/auth';
import { supabase } from '../lib/supabase';
import { useApp } from '../lib/AppContext';
// @ts-ignore
import { logger } from '../utils/logger';
const FloatingButton = registerPlugin('FloatingButton');
export const Settings = ({ onClose }) => {
    const { activeConnection } = useApp();
    const [floatingEnabled, setFloatingEnabled] = useState(false);
    const [hasPermission, setHasPermission] = useState(false);
    const [snoozeUntil, setSnoozeUntil] = useState(null);
    const [voiceAlertsEnabled, setVoiceAlertsEnabled] = useState(true); // Proactive voice alerts
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
            }
            else {
                // Snooze expired
                localStorage.removeItem('floatingButton.snoozeUntil');
                setFloatingEnabled(savedEnabled);
            }
        }
        else {
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
        }
        catch (e) {
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
            }
            catch (e) {
                logger.error('Failed to start floating button:', e);
                alert('Failed to enable floating button. Please grant overlay permission in settings.');
            }
        }
        else {
            // Turning OFF (indefinitely)
            await stopFloatingButton();
            localStorage.setItem('floatingButton.enabled', 'false');
        }
    };
    const stopFloatingButton = async () => {
        try {
            await FloatingButton.stop();
            setFloatingEnabled(false);
        }
        catch (e) {
            logger.warn('FloatingButton plugin not available');
        }
    };
    const handleSnooze = async (hours) => {
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
        if (!snoozeUntil)
            return '';
        const remaining = snoozeUntil - Date.now();
        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
        return `${hours}h ${minutes}m remaining`;
    };
    return (_jsxs("div", { className: "settings-panel", style: {
            padding: '20px',
            background: 'var(--bg-card)',
            borderRadius: '16px',
            border: '1px solid var(--border)',
            maxHeight: '80vh',
            overflowY: 'auto'
        }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }, children: [_jsx("h2", { style: { margin: 0 }, children: "\u2699\uFE0F Settings" }), onClose && _jsx("button", { onClick: onClose, style: { background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }, children: "\u00D7" })] }), _jsxs("div", { style: { marginBottom: '24px' }, children: [_jsx("h3", { style: { marginBottom: '12px' }, children: "\uD83D\uDD35 Floating Button" }), _jsx("p", { style: { fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '12px' }, children: "Show a floating mic button on top of all apps" }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }, children: [_jsxs("label", { className: "toggle-switch", children: [_jsx("input", { type: "checkbox", checked: floatingEnabled && !snoozeUntil, onChange: handleToggle }), _jsx("span", { className: "toggle-slider" })] }), _jsx("span", { children: floatingEnabled && !snoozeUntil ? 'Enabled' : snoozeUntil ? 'Snoozed' : 'Disabled' })] }), snoozeUntil && (_jsxs("div", { style: {
                            background: 'rgba(255, 193, 7, 0.1)',
                            padding: '12px',
                            borderRadius: '8px',
                            marginBottom: '12px'
                        }, children: [_jsxs("p", { style: { margin: 0, fontSize: '0.9rem' }, children: ["\u23F8\uFE0F Snoozed \u2014 ", formatSnoozeRemaining()] }), _jsx("button", { onClick: () => {
                                    localStorage.removeItem('floatingButton.snoozeUntil');
                                    setSnoozeUntil(null);
                                    handleToggle();
                                }, style: { marginTop: '8px', padding: '4px 12px', fontSize: '0.85rem' }, children: "Resume Now" })] })), floatingEnabled && !snoozeUntil && (_jsxs("div", { children: [_jsx("p", { style: { fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }, children: "Hide temporarily:" }), _jsxs("div", { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' }, children: [_jsx("button", { onClick: () => handleSnooze(1), style: { padding: '6px 12px', fontSize: '0.85rem' }, children: "1 hour" }), _jsx("button", { onClick: () => handleSnooze(4), style: { padding: '6px 12px', fontSize: '0.85rem' }, children: "4 hours" }), _jsx("button", { onClick: handleSnoozeUntilTomorrow, style: { padding: '6px 12px', fontSize: '0.85rem' }, children: "Until tomorrow" })] })] })), !hasPermission && (_jsx("p", { style: {
                            fontSize: '0.85rem',
                            color: '#ef4444',
                            marginTop: '12px'
                        }, children: "\u26A0\uFE0F Overlay permission required. Tap the toggle to grant." }))] }), _jsxs("div", { style: { marginBottom: '24px' }, children: [_jsx("h3", { style: { marginBottom: '12px' }, children: "\uD83D\uDC64 Account" }), _jsx("button", { onClick: async () => {
                            await signOut();
                            if (onClose)
                                onClose();
                            // App state listener handles redirect to Auth screen
                        }, style: {
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
                        }, children: "Log Out" })] }), _jsxs("div", { style: { marginBottom: '24px' }, children: [_jsx("h3", { style: { marginBottom: '12px' }, children: "\uD83D\uDCE2 Voice Alerts" }), _jsx("p", { style: { fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '12px' }, children: "Butler speaks proactive suggestions and alerts aloud" }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '12px' }, children: [_jsxs("label", { className: "toggle-switch", children: [_jsx("input", { type: "checkbox", checked: voiceAlertsEnabled, onChange: () => {
                                            const newValue = !voiceAlertsEnabled;
                                            setVoiceAlertsEnabled(newValue);
                                            localStorage.setItem('settings.voiceAlerts', String(newValue));
                                        } }), _jsx("span", { className: "toggle-slider" })] }), _jsx("span", { children: voiceAlertsEnabled ? 'Enabled' : 'Disabled' })] })] }), _jsxs("div", { style: { marginBottom: '24px' }, children: [_jsx("h3", { style: { marginBottom: '12px' }, children: "\uD83E\uDDE0 Recommendation History" }), _jsx("p", { style: { fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '12px' }, children: "Butler learns from automations you ignore. Clearing this history resets that learning." }), _jsx("button", { onClick: async () => {
                            if (!activeConnection?.id) {
                                alert('No active connection found.');
                                return;
                            }
                            const confirmed = window.confirm('This will reset your AI learning for rejected automations.\n\n' +
                                'Butler will start suggesting these types of automations to you again.\n\n' +
                                'Are you sure you want to continue?');
                            if (!confirmed)
                                return;
                            setClearingHistory(true);
                            try {
                                const { error, count } = await supabase
                                    .from('suggestions')
                                    .delete()
                                    .eq('connection_id', activeConnection.id)
                                    .eq('status', 'rejected');
                                if (error) {
                                    alert('Failed to clear history: ' + error.message);
                                }
                                else {
                                    alert('✅ Recommendation history cleared!');
                                }
                            }
                            catch (e) {
                                alert('Error: ' + e.message);
                            }
                            finally {
                                setClearingHistory(false);
                            }
                        }, disabled: clearingHistory, style: {
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
                        }, children: clearingHistory ? '⏳ Clearing...' : '🗑️ Clear Rejected Proposals' })] }), _jsxs("div", { children: [_jsx("h3", { style: { marginBottom: '12px' }, children: "\uD83D\uDCF1 Home Screen Widget" }), _jsx("p", { style: { fontSize: '0.9rem', color: 'var(--text-secondary)' }, children: "Add the Butler widget to your home screen for quick voice access." }), _jsx("p", { style: { fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '8px' }, children: "Long-press your home screen \u2192 Widgets \u2192 Butler" })] })] }));
};
