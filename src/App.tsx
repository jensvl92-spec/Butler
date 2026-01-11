import React, { useEffect, useState, useRef } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { useApp } from './lib/AppContext'
import { Auth } from './components/Auth'
import { ConnectionSetup } from './components/ConnectionSetup'
import { AIChat } from './components/AIChat'
import { Dashboard, DashboardRef } from './components/Dashboard'
import { ButlerSuggestions } from './components/ButlerSuggestions'
import { SuggestionPopup } from './components/SuggestionPopup'
import { Settings } from './components/Settings'
import { Graphs, GraphConfig } from './components/Graphs'
import { signOut } from './utils/auth'
import { registerPushNotifications, setActionListener, setSuggestionsListener } from './utils/pushNotifications'
import { setGraphCreateCallback } from './lib/hooks/useAIChatLogic'
import { supabase } from './lib/supabase'
import { syncGoogleTokens } from './utils/auth'
import './App.css'

// @ts-ignore
import { logger } from './utils/logger'

// Global state for shared text (accessible from AIChat component)
export let sharedTextForTranslation: string | null = null;
export const clearSharedText = () => { sharedTextForTranslation = null; };

function App() {
  const { user, loading, connections, activeConnection, setActiveConnection, deleteConnection, setShouldTriggerVoice } = useApp()
  const [showConnectionModal, setShowConnectionModal] = useState(false)
  const [showConnectionDropdown, setShowConnectionDropdown] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showDebug, setShowDebug] = useState(false) // Debug State
  const [showGraphs, setShowGraphs] = useState(false) // Graphs Page
  const [pendingGraphs, setPendingGraphs] = useState<Omit<GraphConfig, 'id' | 'createdAt'>[]>([])
  const dashboardRef = useRef<DashboardRef>(null)
  const [pendingSuggestions, setPendingSuggestions] = useState<any[]>([])

  // Theme State (Hoisted for Global Header)
  const [theme, setTheme] = useState(localStorage.getItem('app-theme') || 'dark')

  // AI Section Resize State - Default to ~35% of screen height
  const [aiSectionHeight, setAiSectionHeight] = useState(() => {
    if (typeof window !== 'undefined') {
      return Math.floor(window.innerHeight * 0.35);
    }
    return 300;
  });
  const isResizingAi = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(0)

  const handleResizeStart = (clientY: number) => {
    isResizingAi.current = true
    startY.current = clientY
    startHeight.current = aiSectionHeight
    document.body.style.userSelect = 'none'
  }

  const handleResizeMove = (clientY: number) => {
    if (!isResizingAi.current) return
    const delta = clientY - startY.current
    const newHeight = Math.max(200, Math.min(window.innerHeight * 0.8, startHeight.current + delta))
    setAiSectionHeight(newHeight)
  }

  const handleResizeEnd = () => {
    isResizingAi.current = false
    document.body.style.userSelect = ''
  }

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => handleResizeMove(e.clientY)
    const onTouchMove = (e: TouchEvent) => handleResizeMove(e.touches[0].clientY)
    const onUp = () => handleResizeEnd()

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', onTouchMove)
    window.addEventListener('touchend', onUp)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onUp)
    }
  }, [aiSectionHeight])

  useEffect(() => {
    document.body.className = ''
    if (theme !== 'dark') document.body.classList.add(`theme-${theme}`)
    localStorage.setItem('app-theme', theme)
  }, [theme])

  // ... existing state ...

  // Deep Link Listener (Widget Support & Auth Callback)
  useEffect(() => {
    const handleDeepLink = async (url: string) => {
      logger.info('📱 Deep Link Opened:', url);

      // 1. Voice Widget
      if (url.includes('butler://voice')) {
        logger.info("🎤 Triggering Voice Mode");
        setShouldTriggerVoice(true);
      }
      // 2. Auth Callback (Google OAuth)
      else if (url.includes('butler://auth/callback')) {
        logger.info("🔐 Auth Callback detected");
        // Extract hash params (Implicit Flow) or query params
        // Supabase often returns tokens in hash: #access_token=...&refresh_token=...
        const hashIndex = url.indexOf('#');
        if (hashIndex !== -1) {
          const hash = url.substring(hashIndex + 1);
          const params = new URLSearchParams(hash);
          const access_token = params.get('access_token');
          const refresh_token = params.get('refresh_token');
          const provider_token = params.get('provider_token');
          const provider_refresh_token = params.get('provider_refresh_token');

          if (access_token && refresh_token) {
            logger.info("🔐 Setting Supabase Session...");
            const { data, error } = await supabase.auth.setSession({
              access_token,
              refresh_token
            });
            if (error) {
              logger.error("❌ Failed to set session", error);
              alert("Authorization Failed: " + error.message);
            } else {
              if (data.session) {
                syncGoogleTokens(data.session, {
                  access_token: provider_token || '',
                  refresh_token: provider_refresh_token || undefined
                });
              }
              logger.info("✅ Session restored from deep link!");
              alert("Google Authorization Successful! You can now use Calendar/Tasks.");
            }
          }
        }
      }
    };

    // Check launch URL
    CapacitorApp.getLaunchUrl().then(launchUrl => {
      if (launchUrl?.url) handleDeepLink(launchUrl.url);
    });

    // Listen for runtime URL opens
    const listener = CapacitorApp.addListener('appUrlOpen', (data: any) => {
      handleDeepLink(data.url);
    });

    return () => {
      listener.then(l => l.remove());
    };
  }, []);

  // Check for shared text from other apps (e.g., Line, WhatsApp)
  useEffect(() => {
    const checkSharedIntent = async () => {
      try {
        // @ts-ignore - checkSendIntentReceived exists on Android, not in web types
        const result = await SendIntent.checkSendIntentReceived();
        if (result && result.title) {
          // If text was shared, store it for auto-translation
          const sharedText = result.title;
          logger.info(`📥 Received shared text: "${sharedText.substring(0, 50)}..."`);
          sharedTextForTranslation = sharedText;
        }
      } catch (e: any) {
        // No shared intent - this is normal when app opens normally
        logger.info('No shared intent detected');
      }
    };
    checkSharedIntent();
  }, []);

  // Wire up graph creation callback
  useEffect(() => {
    setGraphCreateCallback((config: any) => {
      // Add graph to localStorage and open Graphs page
      const STORAGE_KEY = 'butler_graphs';
      const stored = localStorage.getItem(STORAGE_KEY);
      const graphs = stored ? JSON.parse(stored) : [];

      const newGraph = {
        ...config,
        id: `graph_${Date.now()}`,
        createdAt: Date.now()
      };

      // Remove oldest if at max (5)
      const updated = graphs.length >= 5
        ? [...graphs.slice(1), newGraph]
        : [...graphs, newGraph];

      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      setShowGraphs(true);
      logger.info('📊 Graph created and navigating to Graphs page');
    });
  }, []);


  // Helper to ensure clean origin
  const getCleanUrl = (url: string) => {
    try { return new URL(url).origin } catch { return url }
  }

  useEffect(() => {
    if (connections.length > 0 && !activeConnection) {
      setActiveConnection(connections[0])
    }

    // ... existing code ...

    // Register Push & Action Listener if we have an active connection
    if (activeConnection) {
      registerPushNotifications(activeConnection.id)

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
        } catch (e) {
          logger.error("Failed to bootstrap Ghost Runner:", e);
        }
      };
      // Run once on connect
      bootstrapGhostRunner();

      // GLOBAL BACKGROUND LISTENER (HTTP-based JSON)
      setActionListener(async (actions: any[]) => {
        logger.info("⚡ Global Action Listener Triggered:", actions);
        if (!activeConnection) { logger.warn("No active connection for background action"); return; }

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
                // Use Android Intent URL scheme to open Clock app directly
                // android.intent.action.SET_ALARM
                const intentUri = `intent:#Intent;action=android.intent.action.SET_ALARM;i.android.intent.extra.alarm.HOUR=${hour};i.android.intent.extra.alarm.MINUTES=${minute};S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(message || 'Alarm')};B.android.intent.extra.alarm.SKIP_UI=false;B.android.intent.extra.alarm.VIBRATE=true;end`;
                window.open(intentUri, '_system');
                logger.info("✅ Alarm Intent Sent");
              } catch (alarmError: any) {
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
              } else {
                const errText = await createRes.text();
                logger.error("Script creation failed:", errText);
              }
              return;
            }

            // HANDLER: Standard Service Call (Handles Ghost Runner Calls too!)
            // HANDLER: Standard Service Call (Handles Ghost Runner Calls too!)
            if (!action.entity_id) return;

            // Fix: Handle cases where 'service' is missing but 'type' is present (e.g. "switch.turn_on")
            let domain = action.entity_id.split('.')[0];
            let service = action.service;

            if (!service && action.type && action.type.includes('.')) {
              const parts = action.type.split('.');
              service = parts.length > 1 ? parts[1] : parts[0];
            }

            // Fallback for missing service
            if (!service) {
              logger.warn("Action missing service:", action);
              return;
            }

            const url = `${cleanApiUrl}/api/services/${domain}/${service}`;
            logger.info(`📡 Background Fetch: ${url}`);

            // 🛡️ Payload Clean: Don't allow entity_id override if we are calling a script directly
            // (Unless it's a generic service like turn_on)
            const payload: any = { ...action.data };
            if (domain !== 'script' || ['turn_on', 'turn_off', 'toggle', 'reload'].includes(service)) {
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
          } catch (e: any) {
            logger.error(`❌ Background Action Failed:`, { message: e.message, stack: e.stack });
          }
        }));
      });
      // Register suggestions handler to load suggestions when notification is tapped
      setSuggestionsListener(async () => {
        if (!activeConnection?.id) return;
        const { data } = await supabase
          .from('suggestions')
          .select('*')
          .eq('connection_id', activeConnection.id)
          .eq('status', 'pending')
          .order('created_at', { ascending: false });
        if (data && data.length > 0) {
          setPendingSuggestions(data);
          logger.info(`📋 Loaded ${data.length} suggestions from notification tap`);
        }
      });
    }
  }, [connections, activeConnection, setActiveConnection])

  const handleDeleteConnection = async (e: React.MouseEvent, connId: string) => {
    e.stopPropagation()
    if (window.confirm('Are you sure you want to delete this connection?')) {
      try {
        await deleteConnection(connId)
        logger.info(`Deleted connection: ${connId}`)
      } catch (err: any) {
        logger.error(`Failed to delete connection`, { id: connId, error: err.message })
        alert(`Failed to delete: ${err.message}`)
      }
    }
  }

  if (loading) {
    return <div className="loading">Loading...</div>
  }

  if (!user) {
    return <Auth onAuthSuccess={() => { }} />
  }

  return (
    <div className="app-container" style={{ flexDirection: 'column' }}>
      {/* Setup Wizard (One-Click Install) */}

      {/* Global Header (Restored) */}
      <header className="app-header" style={{
        display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', flexShrink: 0
      }}>
        {/* Top Row: Title */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}>
          <div style={{ fontSize: '1.8rem' }}>👤</div>
          <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Butler</h1>
        </div>

        {/* Controls Row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
          {/* 1. Connection Dropdown */}
          <div className="connection-dropdown" style={{ position: 'relative' }}>
            <button onClick={() => setShowConnectionDropdown(!showConnectionDropdown)} style={{
              padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px',
              display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)', minWidth: '140px', justifyContent: 'space-between'
            }}>
              {activeConnection ? activeConnection.name : 'Select Connection'}
              <span>▼</span>
            </button>
            {showConnectionDropdown && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, marginTop: '4px', background: 'var(--bg-elevated)',
                border: '1px solid var(--border)', borderRadius: '8px', zIndex: 100, width: '100%', overflow: 'hidden'
              }}>
                {connections.map(c => (
                  <div key={c.id} onClick={() => { setActiveConnection(c); setShowConnectionDropdown(false) }}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--border)',
                      fontSize: '0.9rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}>
                    <span>{c.name}</span>
                    <button
                      onClick={(e) => handleDeleteConnection(e, c.id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        padding: '4px',
                        borderRadius: '4px',
                        fontSize: '1rem'
                      }}
                      title="Delete Connection"
                    >
                      🗑️
                    </button>
                  </div>
                ))}
                <div onClick={() => { setShowConnectionModal(true); setShowConnectionDropdown(false) }}
                  style={{ padding: '8px 12px', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', fontSize: '0.9rem', textAlign: 'center' }}>
                  + Add Connection
                </div>
              </div>
            )}
          </div>

          {/* 2. Controls Group (Sync, Theme, Logout) */}
          <div style={{ display: 'flex', gap: '8px' }}>
            {activeConnection && (
              <button onClick={() => dashboardRef.current?.importLayoutFromHA()} title="Sync" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--accent)', width: '40px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                ↻
              </button>
            )}

            {/* Theme Dropdown (Compact) */}
            <select value={theme} onChange={(e) => setTheme(e.target.value)} style={{
              background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0 8px', outline: 'none'
            }}>
              <option value="dark">Dark</option>
              <option value="white">White</option>
              <option value="light">Light</option>
              <option value="pastel-mint">Mint</option>
              <option value="pastel-rose">Rose</option>
            </select>

            {/* Settings Button */}
            <button onClick={() => setShowSettings(true)} title="Settings" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)', width: '40px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              ⚙️
            </button>

            {/* Graphs Button */}
            <button onClick={() => setShowGraphs(true)} title="Graphs" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)', width: '40px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              📊
            </button>

            <button className="logout-btn" onClick={() => activeConnection && setActiveConnection(null)}>
              Logout
            </button>
          </div>
        </div>
      </header>

      <div className="main-content">
        {/* AI Chat Section - Matches Screenshot Card Style */}
        {/* AI Chat Section - Matches Screenshot Card Style */}
        <div className="ai-section" style={{ height: activeConnection ? aiSectionHeight : 'auto' }}>
          <div style={{
            background: 'var(--bg-card)',
            borderRadius: '16px',
            border: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            boxShadow: 'var(--shadow-md)',
            overflow: 'hidden'
          }}>
            <div className="ai-section-header" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px 16px 8px 16px' }}>
              <div className="ai-icon" style={{ fontSize: '1.5rem', background: 'rgba(99, 102, 241, 0.2)', width: '36px', height: '36px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🤖</div>
              <h2 style={{ fontSize: '1.2rem', margin: 0, color: 'var(--text-primary)' }}>AI Assistant</h2>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <AIChat />
            </div>
            {/* Resize Handle */}
            <div
              className="ai-resize-handle"
              onMouseDown={(e) => handleResizeStart(e.clientY)}
              onTouchStart={(e) => handleResizeStart(e.touches[0].clientY)}
            >
              <div className="handle-bar" />
            </div>
          </div>
        </div>


        {/* Room Tiles Dashboard */}
        <div className="dashboard">


          {activeConnection && <Dashboard ref={dashboardRef} />}

          {!activeConnection && (
            <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <p>No connection selected.</p>
              <button onClick={() => setShowConnectionModal(true)} style={{ marginTop: '16px' }}>
                + Add Connection
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Connection Setup Modal */}
      {showConnectionModal && (
        <div className="modal-overlay" onClick={() => setShowConnectionModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2>Add Home Assistant Connection</h2>
            <ConnectionSetup onConnectionAdded={() => setShowConnectionModal(false)} />
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <Settings onClose={() => setShowSettings(false)} />
          </div>
        </div>
      )}

      {/* Graphs Full-Page */}
      {showGraphs && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'var(--bg-primary)', overflow: 'auto' }}>
          <Graphs onBack={() => setShowGraphs(false)} />
        </div>
      )}

      {/* Proactive Butler Suggestions (Floating) */}
      <ButlerSuggestions />

      {/* Suggestions Popup (from push notification tap) */}
      {pendingSuggestions.length > 0 && (
        <SuggestionPopup
          suggestions={pendingSuggestions}
          onClose={() => setPendingSuggestions([])}
          onAction={async (id, action) => {
            // Update DB
            await supabase.from('suggestions').update({
              status: action === 'accept' ? 'accepted' : 'rejected'
            }).eq('id', id);
            // Remove from local state
            setPendingSuggestions(prev => prev.filter(s => s.id !== id));
          }}
        />
      )}
    </div>
  )
}

export default App