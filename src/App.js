import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState, useRef } from 'react';
import { useApp } from './lib/AppContext';
import { Auth } from './components/Auth';
import { ConnectionSetup } from './components/ConnectionSetup';
import { AIChat } from './components/AIChat';
import { Dashboard } from './components/Dashboard';
import { ButlerSuggestions } from './components/ButlerSuggestions';
import { ProxySetupWizard } from './components/ProxySetupWizard';
import { registerPushNotifications, setActionListener } from './utils/pushNotifications';
import './App.css';
// @ts-ignore
import { logger } from './utils/logger';
function App() {
    const { user, loading, connections, activeConnection, setActiveConnection, deleteConnection } = useApp();
    const [showConnectionModal, setShowConnectionModal] = useState(false);
    const [showConnectionDropdown, setShowConnectionDropdown] = useState(false);
    const [showDebug, setShowDebug] = useState(false); // Debug State
    const dashboardRef = useRef(null);
    // Theme State (Hoisted for Global Header)
    const [theme, setTheme] = useState(localStorage.getItem('app-theme') || 'dark');
    // AI Section Resize State - Default to ~35% of screen height
    const [aiSectionHeight, setAiSectionHeight] = useState(() => {
        if (typeof window !== 'undefined') {
            return Math.floor(window.innerHeight * 0.35);
        }
        return 300;
    });
    const isResizingAi = useRef(false);
    const startY = useRef(0);
    const startHeight = useRef(0);
    const handleResizeStart = (clientY) => {
        isResizingAi.current = true;
        startY.current = clientY;
        startHeight.current = aiSectionHeight;
        document.body.style.userSelect = 'none';
    };
    const handleResizeMove = (clientY) => {
        if (!isResizingAi.current)
            return;
        const delta = clientY - startY.current;
        const newHeight = Math.max(200, Math.min(window.innerHeight * 0.8, startHeight.current + delta));
        setAiSectionHeight(newHeight);
    };
    const handleResizeEnd = () => {
        isResizingAi.current = false;
        document.body.style.userSelect = '';
    };
    useEffect(() => {
        const onMouseMove = (e) => handleResizeMove(e.clientY);
        const onTouchMove = (e) => handleResizeMove(e.touches[0].clientY);
        const onUp = () => handleResizeEnd();
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchmove', onTouchMove);
        window.addEventListener('touchend', onUp);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onUp);
        };
    }, [aiSectionHeight]); // Dependency needed for closure? No, using refs. dependency empty is fine usually but we're attaching/detaching. Actually clean up on mount.
    useEffect(() => {
        document.body.className = '';
        if (theme !== 'dark')
            document.body.classList.add(`theme-${theme}`);
        localStorage.setItem('app-theme', theme);
    }, [theme]);
    // Helper to ensure clean origin
    const getCleanUrl = (url) => {
        try {
            return new URL(url).origin;
        }
        catch {
            return url;
        }
    };
    useEffect(() => {
        if (connections.length > 0 && !activeConnection) {
            setActiveConnection(connections[0]);
        }
        // ... existing code ...
        // Register Push & Action Listener if we have an active connection
        if (activeConnection) {
            registerPushNotifications(activeConnection.id);
            // 👻 GHOST RUNNER BOOTSTRAP (Ensures the reusable script exists)
            const cleanApiUrl = getCleanUrl(activeConnection.api_url);
            const bootstrapGhostRunner = async () => {
                try {
                    // Check if exists (by trying to get it, or just blindly overwriting - overwriting is safer/easier)
                    // We use the ID 'ai_ghost_runner'
                    const ghostScript = {
                        alias: "AI Ghost Runner",
                        mode: "parallel",
                        icon: "mdi:ghost",
                        fields: {
                            delay: { description: "Time to wait (HH:MM:SS)", example: "00:00:30" },
                            service: { description: "Service to call", example: "light.turn_on" },
                            entity: { description: "Entity ID", example: "light.kitchen" }
                        },
                        sequence: [
                            { delay: "{{ delay }}" },
                            { service: "{{ service }}", target: { entity_id: "{{ entity }}" } }
                        ]
                    };
                    // Idempotent creation (overwrites if exists)
                    await fetch(`${cleanApiUrl}/api/config/script/config/ai_ghost_runner`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${activeConnection.api_token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(ghostScript)
                    });
                    logger.info("👻 Ghost Runner Configured: script.ai_ghost_runner");
                }
                catch (e) {
                    logger.error("Failed to bootstrap Ghost Runner:", e);
                }
            };
            // Run once on connect
            bootstrapGhostRunner();
            // GLOBAL BACKGROUND LISTENER (HTTP-based JSON)
            setActionListener(async (actions) => {
                logger.info("⚡ Global Action Listener Triggered:", actions);
                if (!activeConnection) {
                    logger.warn("No active connection for background action");
                    return;
                }
                const cleanApiUrl = getCleanUrl(activeConnection.api_url);
                await Promise.allSettled(actions.map(async (action) => {
                    try {
                        // HANDLER: Set Alarm (Native)
                        if (action.type === 'set_alarm') {
                            const { hour, minute, message, days } = action.data || {};
                            if (typeof hour !== 'number' || typeof minute !== 'number') {
                                logger.error("Invalid alarm data:", action.data);
                                return;
                            }
                            logger.info(`⏰ Setting alarm for ${hour}:${minute.toString().padStart(2, '0')} - ${message || 'Alarm'}`);
                            try {
                                const { CapgoAlarm } = await import('@capgo/capacitor-alarm');
                                await CapgoAlarm.createAlarm({
                                    hour,
                                    minute,
                                    label: message || 'Alarm',
                                    skipUi: false, // Show alarm UI to user
                                    vibrate: true,
                                });
                                logger.info("✅ Alarm set successfully");
                            }
                            catch (alarmError) {
                                logger.error("Failed to set alarm:", alarmError);
                                alert(`Failed to set alarm: ${alarmError.message || 'Unknown error'}`);
                            }
                            return;
                        }
                        // HANDLER: Create Native Script (Legacy/Fallback)
                        if (action.type === 'create_script') {
                            const idStr = action.data?.alias ? action.data.alias.toLowerCase().replace(/[^a-z0-9]/g, '_') : 'ai_script';
                            const uniqueId = `${idStr}_${Date.now()}`;
                            const payload = {
                                alias: action.data?.alias || "AI Scheduled Task",
                                sequence: action.data?.sequence || []
                            };
                            logger.info(`🛠️ Creating Remote Script: ${cleanApiUrl}/api/config/script/config/${uniqueId}`);
                            // 1. Create
                            const createRes = await fetch(`${cleanApiUrl}/api/config/script/config/${uniqueId}`, {
                                method: 'POST',
                                headers: { 'Authorization': `Bearer ${activeConnection.api_token}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            });
                            if (createRes.ok) {
                                // 2. Execute
                                logger.info(`▶️ Starting Remote Script: script.${uniqueId}`);
                                await fetch(`${cleanApiUrl}/api/services/script/turn_on`, {
                                    method: 'POST',
                                    headers: { 'Authorization': `Bearer ${activeConnection.api_token}`, 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ entity_id: `script.${uniqueId}` })
                                });
                            }
                            else {
                                const errText = await createRes.text();
                                logger.error("Script creation failed:", errText);
                            }
                            return;
                        }
                        // HANDLER: Standard Service Call (Handles Ghost Runner Calls too!)
                        if (!action.entity_id)
                            return;
                        const [domain] = action.entity_id.split('.');
                        const url = `${cleanApiUrl}/api/services/${domain}/${action.service}`;
                        logger.info(`📡 Background Fetch: ${url}`);
                        // 🛡️ Payload Clean: Don't allow entity_id override if we are calling a script directly
                        // (Unless it's a generic service like turn_on)
                        const payload = { ...action.data };
                        if (domain !== 'script' || ['turn_on', 'turn_off', 'toggle', 'reload'].includes(action.service)) {
                            payload.entity_id = action.entity_id;
                        }
                        await fetch(url, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${activeConnection.api_token}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(payload)
                        });
                    }
                    catch (e) {
                        logger.error(`❌ Background Action Failed:`, { message: e.message, stack: e.stack });
                    }
                }));
            });
        }
    }, [connections, activeConnection, setActiveConnection]);
    const handleDeleteConnection = async (e, connId) => {
        e.stopPropagation();
        if (window.confirm('Are you sure you want to delete this connection?')) {
            try {
                await deleteConnection(connId);
                logger.info(`Deleted connection: ${connId}`);
            }
            catch (err) {
                logger.error(`Failed to delete connection`, { id: connId, error: err.message });
                alert(`Failed to delete: ${err.message}`);
            }
        }
    };
    if (loading) {
        return _jsx("div", { className: "loading", children: "Loading..." });
    }
    if (!user) {
        return _jsx(Auth, { onAuthSuccess: () => { } });
    }
    return (_jsxs("div", { className: "app-container", style: { flexDirection: 'column' }, children: [_jsxs("header", { className: "app-header", style: {
                    display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', flexShrink: 0
                }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }, children: [_jsx("div", { style: { fontSize: '1.8rem' }, children: "\uD83D\uDC64" }), _jsx("h1", { style: { fontSize: '1.5rem', margin: 0 }, children: "Butler" })] }), _jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }, children: [_jsxs("div", { className: "connection-dropdown", style: { position: 'relative' }, children: [_jsxs("button", { onClick: () => setShowConnectionDropdown(!showConnectionDropdown), style: {
                                            padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px',
                                            display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)', minWidth: '140px', justifyContent: 'space-between'
                                        }, children: [activeConnection ? activeConnection.name : 'Select Connection', _jsx("span", { children: "\u25BC" })] }), showConnectionDropdown && (_jsxs("div", { style: {
                                            position: 'absolute', top: '100%', left: 0, marginTop: '4px', background: 'var(--bg-elevated)',
                                            border: '1px solid var(--border)', borderRadius: '8px', zIndex: 100, width: '100%', overflow: 'hidden'
                                        }, children: [connections.map(c => (_jsxs("div", { onClick: () => { setActiveConnection(c); setShowConnectionDropdown(false); }, style: {
                                                    padding: '8px 12px',
                                                    cursor: 'pointer',
                                                    borderBottom: '1px solid var(--border)',
                                                    fontSize: '0.9rem',
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    alignItems: 'center'
                                                }, children: [_jsx("span", { children: c.name }), _jsx("button", { onClick: (e) => handleDeleteConnection(e, c.id), style: {
                                                            background: 'none',
                                                            border: 'none',
                                                            color: 'var(--text-secondary)',
                                                            cursor: 'pointer',
                                                            padding: '4px',
                                                            borderRadius: '4px',
                                                            fontSize: '1rem'
                                                        }, title: "Delete Connection", children: "\uD83D\uDDD1\uFE0F" })] }, c.id))), _jsx("div", { onClick: () => { setShowConnectionModal(true); setShowConnectionDropdown(false); }, style: { padding: '8px 12px', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', fontSize: '0.9rem', textAlign: 'center' }, children: "+ Add Connection" })] }))] }), _jsxs("div", { style: { display: 'flex', gap: '8px' }, children: [activeConnection && (_jsx("button", { onClick: () => dashboardRef.current?.importLayoutFromHA(), title: "Sync", style: { background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--accent)', width: '40px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }, children: "\u21BB" })), _jsxs("select", { value: theme, onChange: (e) => setTheme(e.target.value), style: {
                                            background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0 8px', outline: 'none'
                                        }, children: [_jsx("option", { value: "dark", children: "Dark" }), _jsx("option", { value: "white", children: "White" }), _jsx("option", { value: "light", children: "Light" }), _jsx("option", { value: "pastel-mint", children: "Mint" }), _jsx("option", { value: "pastel-rose", children: "Rose" })] }), _jsx("button", { className: "logout-btn", onClick: () => activeConnection && setActiveConnection(null), children: "Logout" })] })] })] }), _jsxs("div", { className: "main-content", children: [_jsx("div", { className: "ai-section", style: { height: activeConnection ? aiSectionHeight : 'auto' }, children: _jsxs("div", { style: {
                                background: 'var(--bg-card)',
                                borderRadius: '16px',
                                border: '1px solid var(--border)',
                                display: 'flex',
                                flexDirection: 'column',
                                height: '100%',
                                boxShadow: 'var(--shadow-md)',
                                overflow: 'hidden'
                            }, children: [_jsxs("div", { className: "ai-section-header", style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '16px 16px 8px 16px' }, children: [_jsx("div", { className: "ai-icon", style: { fontSize: '1.5rem', background: 'rgba(99, 102, 241, 0.2)', width: '36px', height: '36px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }, children: "\uD83E\uDD16" }), _jsx("h2", { style: { fontSize: '1.2rem', margin: 0, color: 'var(--text-primary)' }, children: "AI Assistant" })] }), _jsx("div", { style: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }, children: _jsx(AIChat, {}) }), _jsx("div", { className: "ai-resize-handle", onMouseDown: (e) => handleResizeStart(e.clientY), onTouchStart: (e) => handleResizeStart(e.touches[0].clientY), children: _jsx("div", { className: "handle-bar" }) })] }) }), _jsxs("div", { className: "dashboard", children: [activeConnection && (_jsx(ProxySetupWizard, { activeConnection: activeConnection, onComplete: () => { logger.info("Setup Wizard Complete"); } })), activeConnection && _jsx(Dashboard, { ref: dashboardRef }), !activeConnection && (_jsxs("div", { className: "empty-state", style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }, children: [_jsx("p", { children: "No connection selected." }), _jsx("button", { onClick: () => setShowConnectionModal(true), style: { marginTop: '16px' }, children: "+ Add Connection" })] }))] })] }), showConnectionModal && (_jsx("div", { className: "modal-overlay", onClick: () => setShowConnectionModal(false), children: _jsxs("div", { className: "modal-content", onClick: e => e.stopPropagation(), children: [_jsx("h2", { children: "Add Home Assistant Connection" }), _jsx(ConnectionSetup, { onConnectionAdded: () => setShowConnectionModal(false) })] }) })), _jsx(ButlerSuggestions, {})] }));
}
export default App;
