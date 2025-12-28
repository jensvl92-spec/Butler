import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { logger } from '../utils/logger';
export const ProxySetupWizard = ({ activeConnection, onComplete }) => {
    const [status, setStatus] = useState('checking');
    const [progress, setProgress] = useState(0);
    const [errorMsg, setErrorMsg] = useState(null);
    // Helper for API calls
    const haFetch = async (endpoint, method = 'GET', body) => {
        // Clean URL
        const baseUrl = activeConnection.api_url.replace(/\/$/, '');
        const url = `${baseUrl}${endpoint}`;
        const headers = {
            'Authorization': `Bearer ${activeConnection.api_token}`,
            'Content-Type': 'application/json',
        };
        const res = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });
        if (!res.ok) {
            // If 404 on info, it means not installed
            if (res.status === 404 && endpoint.includes('/info')) {
                throw new Error('NOT_FOUND');
            }
            const text = await res.text();
            throw new Error(`API Error ${res.status}: ${text}`);
        }
        return res.json();
    };
    const checkStatus = async () => {
        try {
            setStatus('checking');
            // Check if installed
            const info = await haFetch('/api/hassio/addons/butler_crew/info');
            if (info.data.state === 'started') {
                setStatus('running');
                onComplete(); // Already good
            }
            else {
                setStatus('stopped');
            }
        }
        catch (e) {
            if (e.message === 'NOT_FOUND') {
                setStatus('missing');
            }
            else {
                logger.error("Setup Check Failed", e);
                // If we can't access Supervisor (e.g. non-admin or no permissions), we might fail here.
                // Fallback: If 403/401, maybe show manual instructions?
                // For now, assume Not Found or Error
                if (e.message.includes('401') || e.message.includes('403')) {
                    // Non-admin user cannot check status via Supervisor API
                    setStatus('permission_denied');
                }
                else {
                    // It's possible the slug is different or repo not added, assume missing if 404
                    setStatus('missing');
                }
            }
        }
    };
    useEffect(() => {
        // Check if user previously dismissed/installed
        const installed = localStorage.getItem('butler_proxy_installed');
        if (installed === 'true') {
            setStatus('running'); // Pretend it's running to hide logic (or use a new 'hidden' state)
            onComplete();
        }
        else {
            checkStatus();
        }
    }, [activeConnection]);
    const handleInstall = async () => {
        try {
            setErrorMsg(null);
            setStatus('installing');
            setProgress(10);
            // 1. Add Repository
            logger.info("Adding Repository...");
            try {
                await haFetch('/api/hassio/store/repositories', 'POST', {
                    url: "https://github.com/jensvl92-spec/Butler"
                });
            }
            catch (repoErr) {
                // Ignore if already exists? API usually returns 200 or 400 if duplicate
                logger.warn("Repo add might have failed or exists", repoErr);
            }
            setProgress(30);
            // 2. Install Add-on
            logger.info("Installing Add-on...");
            // This can take a while!
            await haFetch('/api/hassio/addons/butler_crew/install', 'POST');
            setProgress(60);
            // 3. Configure
            setStatus('configuring');
            logger.info("Configuring Add-on...");
            await haFetch('/api/hassio/addons/butler_crew/options', 'POST', {
                options: {
                    mcp_token: activeConnection.api_token, // Reuse App Token
                    log_level: "info"
                    // mcp_server_url uses default or we can set it
                }
            });
            setProgress(80);
            // 4. Start
            setStatus('starting');
            logger.info("Starting Add-on...");
            await haFetch('/api/hassio/addons/butler_crew/start', 'POST');
            // Wait for start?
            setTimeout(() => {
                setStatus('running');
                onComplete();
            }, 5000);
        }
        catch (e) {
            logger.error("Installation Failed", e);
            setErrorMsg(e.message || "Installation Failed");
            setStatus('error');
        }
    };
    const handleStart = async () => {
        try {
            setStatus('starting');
            await haFetch('/api/hassio/addons/butler_crew/start', 'POST');
            setTimeout(() => {
                setStatus('running');
                onComplete();
            }, 3000);
        }
        catch (e) {
            setErrorMsg(e.message);
            setStatus('error');
        }
    };
    if (status === 'running')
        return null; // Only hide if running/installed // Invisible if good
    return (_jsxs("div", { style: {
            margin: '16px',
            padding: '16px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            boxShadow: 'var(--shadow-md)'
        }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }, children: [_jsx("div", { style: {
                            width: '40px', height: '40px', borderRadius: '50%',
                            background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem'
                        }, children: "\uD83E\uDDE0" }), _jsxs("div", { children: [_jsx("h3", { style: { margin: 0, fontSize: '1rem' }, children: "AI Brain Upgrade" }), _jsx("p", { style: { margin: 0, fontSize: '0.8rem', opacity: 0.7 }, children: status === 'missing' ? 'Enhance your Butler with the AI Proxy Server.' : 'Manage your AI Server.' })] })] }), status === 'missing' && (_jsxs("div", { children: [_jsx("p", { style: { fontSize: '0.9rem', marginBottom: '16px' }, children: "To enable smart features (Agent execution, Semantic Search), we need to install the **Butler Proxy** add-on on your Home Assistant." }), _jsxs("button", { onClick: handleInstall, style: {
                            width: '100%', padding: '10px', borderRadius: '8px', border: 'none',
                            background: 'var(--primary)', color: 'white', fontWeight: 600, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                        }, children: [_jsx("span", { children: "\uD83D\uDCE5" }), " Install & Configure (One-Click)"] })] })), status === 'stopped' && (_jsxs("button", { onClick: handleStart, style: {
                    width: '100%', padding: '10px', borderRadius: '8px', border: 'none',
                    background: 'var(--success)', color: 'white', fontWeight: 600, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                }, children: [_jsx("span", { children: "\u25B6\uFE0F" }), " Start AI Server"] })), (status === 'installing' || status === 'configuring' || status === 'starting') && (_jsxs("div", { style: { textAlign: 'center', padding: '10px' }, children: [_jsxs("div", { style: { fontSize: '0.9rem', marginBottom: '8px' }, children: [status === 'installing' && '📦 Installing Add-on...', status === 'configuring' && '⚙️ Configuring Token...', status === 'starting' && '🚀 Starting Service...'] }), _jsx("div", { style: { width: '100%', height: '6px', background: 'var(--bg-secondary)', borderRadius: '3px', overflow: 'hidden' }, children: _jsx("div", { style: { width: `${progress}%`, height: '100%', background: 'var(--primary)', transition: 'width 0.3s' } }) })] })), status === 'error' && (_jsxs("div", { style: { color: 'var(--error)', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '8px' }, children: [_jsx("span", { children: "\u26A0\uFE0F" }), _jsx("span", { children: errorMsg }), _jsx("button", { onClick: checkStatus, style: { marginLeft: 'auto', background: 'none', border: '1px solid var(--border)', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }, children: "Retry" })] })), status === 'permission_denied' && (_jsxs("div", { children: [_jsxs("div", { style: {
                            background: 'rgba(255, 193, 7, 0.1)',
                            border: '1px solid rgba(255, 193, 7, 0.3)',
                            borderRadius: '8px',
                            padding: '12px',
                            marginBottom: '16px'
                        }, children: [_jsx("p", { style: { margin: '0 0 8px 0', fontSize: '0.9rem', fontWeight: 600, color: 'var(--warning-text, #b45309)' }, children: "\u26A0\uFE0F Admin Access Required" }), _jsx("p", { style: { margin: 0, fontSize: '0.85rem', opacity: 0.9 }, children: "We couldn't check if \"Butler Crew\" is installed because your user is not an Admin. The app cannot auto-install the add-on for you." })] }), _jsx("p", { style: { fontSize: '0.85rem', marginBottom: '16px', opacity: 0.8 }, children: "If the add-on is already installed and running, you can skip this check." }), _jsxs("div", { style: { display: 'flex', gap: '8px', flexDirection: 'column' }, children: [_jsxs("div", { style: { display: 'flex', gap: '8px' }, children: [_jsx("button", { onClick: checkStatus, style: {
                                            flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
                                            background: 'var(--primary)', color: 'white', fontWeight: 500, cursor: 'pointer'
                                        }, children: "Retry Check" }), _jsx("button", { onClick: () => {
                                            localStorage.setItem('butler_proxy_installed', 'true');
                                            setStatus('running');
                                            onComplete();
                                        }, style: {
                                            flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid var(--border)',
                                            background: 'transparent', color: 'var(--text-primary)', fontWeight: 500, cursor: 'pointer'
                                        }, children: "I have installed it" })] }), _jsxs("div", { style: {
                                    marginTop: '16px',
                                    padding: '12px',
                                    background: 'var(--bg-secondary)',
                                    borderRadius: '8px',
                                    border: '1px solid var(--border)'
                                }, children: [_jsx("p", { style: { fontWeight: 600, fontSize: '0.9rem', marginTop: 0 }, children: "Step-by-Step Manual Installation:" }), _jsxs("ol", { style: { fontSize: '0.85rem', paddingLeft: '20px', lineHeight: '1.5', margin: '8px 0' }, children: [_jsxs("li", { children: ["Open ", _jsx("b", { children: "Settings" }), " in Home Assistant."] }), _jsxs("li", { children: ["Go to ", _jsx("b", { children: "Add-ons" }), " > ", _jsx("b", { children: "Add-on Store" }), "."] }), _jsxs("li", { children: ["Click the three dots (top right) > ", _jsx("b", { children: "Repositories" }), "."] }), _jsxs("li", { children: ["Paste this URL: ", _jsx("br", {}), _jsx("code", { style: { userSelect: 'all', background: 'rgba(0,0,0,0.1)', padding: '2px 4px', borderRadius: '4px' }, children: "https://github.com/jensvl92-spec/Butler" })] }), _jsxs("li", { children: ["Click ", _jsx("b", { children: "Add" }), ". Then close the dialog."] }), _jsx("li", { children: "Refresh the page (F5)." }), _jsxs("li", { children: ["Search for \"Butler Crew\" and click ", _jsx("b", { children: "Install" }), "."] }), _jsxs("li", { children: ["Once installed, click ", _jsx("b", { children: "Start" }), "."] }), _jsx("li", { children: "Enable \"Show in sidebar\" and \"Watchdog\" if desired." })] })] })] })] }))] }));
};
