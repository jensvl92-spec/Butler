import React, { useEffect, useState } from 'react';
// import { Settings, Download, Play, AlertTriangle, CheckCircle, Loader } from 'lucide-react'; // Removed for zero-dependency
import { HAConnection } from '../types';
import { logger } from '../utils/logger';

interface Props {
    activeConnection: HAConnection;
    onComplete: () => void;
}

type SetupStatus = 'checking' | 'missing' | 'stopped' | 'running' | 'installing' | 'configuring' | 'starting' | 'error' | 'permission_denied';

export const ProxySetupWizard: React.FC<Props> = ({ activeConnection, onComplete }) => {
    const [status, setStatus] = useState<SetupStatus>('checking');
    const [progress, setProgress] = useState(0);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Helper for API calls
    const haFetch = async (endpoint: string, method: string = 'GET', body?: any) => {
        // Clean URL
        const baseUrl = activeConnection.api_url.replace(/\/$/, '');
        const url = `${baseUrl}${endpoint}`;

        const headers: any = {
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
            } else {
                setStatus('stopped');
            }
        } catch (e: any) {
            if (e.message === 'NOT_FOUND') {
                setStatus('missing');
            } else {
                logger.error("Setup Check Failed", e);
                // If we can't access Supervisor (e.g. non-admin or no permissions), we might fail here.
                // Fallback: If 403/401, maybe show manual instructions?
                // For now, assume Not Found or Error
                if (e.message.includes('401') || e.message.includes('403')) {
                    // Non-admin user cannot check status via Supervisor API
                    setStatus('permission_denied');
                } else {
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
        } else {
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
            } catch (repoErr: any) {
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

        } catch (e: any) {
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
        } catch (e: any) {
            setErrorMsg(e.message);
            setStatus('error');
        }
    };

    if (status === 'running') return null; // Only hide if running/installed // Invisible if good

    return (
        <div style={{
            margin: '16px',
            padding: '16px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            boxShadow: 'var(--shadow-md)'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                <div style={{
                    width: '40px', height: '40px', borderRadius: '50%',
                    background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem'
                }}>
                    🧠
                </div>
                <div>
                    <h3 style={{ margin: 0, fontSize: '1rem' }}>AI Brain Upgrade</h3>
                    <p style={{ margin: 0, fontSize: '0.8rem', opacity: 0.7 }}>
                        {status === 'missing' ? 'Enhance your Butler with the AI Proxy Server.' : 'Manage your AI Server.'}
                    </p>
                </div>
            </div>

            {status === 'missing' && (
                <div>
                    <p style={{ fontSize: '0.9rem', marginBottom: '16px' }}>
                        To enable smart features (Agent execution, Semantic Search), we need to install the **Butler Proxy** add-on on your Home Assistant.
                    </p>
                    <button
                        onClick={handleInstall}
                        style={{
                            width: '100%', padding: '10px', borderRadius: '8px', border: 'none',
                            background: 'var(--primary)', color: 'white', fontWeight: 600, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                        }}
                    >
                        <span>📥</span> Install & Configure (One-Click)
                    </button>
                </div>
            )}

            {status === 'stopped' && (
                <button
                    onClick={handleStart}
                    style={{
                        width: '100%', padding: '10px', borderRadius: '8px', border: 'none',
                        background: 'var(--success)', color: 'white', fontWeight: 600, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                    }}
                >
                    <span>▶️</span> Start AI Server
                </button>
            )}

            {(status === 'installing' || status === 'configuring' || status === 'starting') && (
                <div style={{ textAlign: 'center', padding: '10px' }}>
                    <div style={{ fontSize: '0.9rem', marginBottom: '8px' }}>
                        {status === 'installing' && '📦 Installing Add-on...'}
                        {status === 'configuring' && '⚙️ Configuring Token...'}
                        {status === 'starting' && '🚀 Starting Service...'}
                    </div>
                    <div style={{ width: '100%', height: '6px', background: 'var(--bg-secondary)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${progress}%`, height: '100%', background: 'var(--primary)', transition: 'width 0.3s' }} />
                    </div>
                </div>
            )}

            {status === 'error' && (
                <div style={{ color: 'var(--error)', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>⚠️</span>
                    <span>{errorMsg}</span>
                    <button onClick={checkStatus} style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--border)', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}>Retry</button>
                </div>
            )}

            {status === 'permission_denied' && (
                <div>
                    <div style={{
                        background: 'rgba(255, 193, 7, 0.1)',
                        border: '1px solid rgba(255, 193, 7, 0.3)',
                        borderRadius: '8px',
                        padding: '12px',
                        marginBottom: '16px'
                    }}>
                        <p style={{ margin: '0 0 8px 0', fontSize: '0.9rem', fontWeight: 600, color: 'var(--warning-text, #b45309)' }}>
                            ⚠️ Admin Access Required
                        </p>
                        <p style={{ margin: 0, fontSize: '0.85rem', opacity: 0.9 }}>
                            We couldn't check if "Butler Crew" is installed because your user is not an Admin.
                            The app cannot auto-install the add-on for you.
                        </p>
                    </div>

                    <p style={{ fontSize: '0.85rem', marginBottom: '16px', opacity: 0.8 }}>
                        If the add-on is already installed and running, you can skip this check.
                    </p>

                    <div style={{ display: 'flex', gap: '8px', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                                onClick={checkStatus}
                                style={{
                                    flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
                                    background: 'var(--primary)', color: 'white', fontWeight: 500, cursor: 'pointer'
                                }}
                            >
                                Retry Check
                            </button>
                            <button
                                onClick={() => {
                                    localStorage.setItem('butler_proxy_installed', 'true');
                                    setStatus('running');
                                    onComplete();
                                }}
                                style={{
                                    flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid var(--border)',
                                    background: 'transparent', color: 'var(--text-primary)', fontWeight: 500, cursor: 'pointer'
                                }}
                            >
                                I have installed it
                            </button>
                        </div>

                        <div style={{
                            marginTop: '16px',
                            padding: '12px',
                            background: 'var(--bg-secondary)',
                            borderRadius: '8px',
                            border: '1px solid var(--border)'
                        }}>
                            <p style={{ fontWeight: 600, fontSize: '0.9rem', marginTop: 0 }}>Step-by-Step Manual Installation:</p>
                            <ol style={{ fontSize: '0.85rem', paddingLeft: '20px', lineHeight: '1.5', margin: '8px 0' }}>
                                <li>Open <b>Settings</b> in Home Assistant.</li>
                                <li>Go to <b>Add-ons</b> &gt; <b>Add-on Store</b>.</li>
                                <li>Click the three dots (top right) &gt; <b>Repositories</b>.</li>
                                <li>Paste this URL: <br /><code style={{ userSelect: 'all', background: 'rgba(0,0,0,0.1)', padding: '2px 4px', borderRadius: '4px' }}>https://github.com/jensvl92-spec/Butler</code></li>
                                <li>Click <b>Add</b>. Then close the dialog.</li>
                                <li>Refresh the page (F5).</li>
                                <li>Search for "Butler Crew" and click <b>Install</b>.</li>
                                <li>Once installed, click <b>Start</b>.</li>
                                <li>Enable "Show in sidebar" and "Watchdog" if desired.</li>
                            </ol>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
