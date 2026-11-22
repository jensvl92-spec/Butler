import React, { useEffect, useState, useRef } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { useApp } from './lib/AppContext'
import { Auth } from './components/Auth'
import { ConnectionSetup } from './components/ConnectionSetup'
import { AIChat } from './components/AIChat'
import { Dashboard, DashboardRef } from './components/Dashboard'
import { ButlerSuggestions } from './components/ButlerSuggestions'
import { SuggestionPopup } from './components/SuggestionPopup'
import { Settings } from './components/Settings'
import { Graphs } from './components/Graphs'
import { registerPushNotifications, setActionListener, setSuggestionsListener } from './utils/pushNotifications'
import { setGraphCreateCallback } from './lib/hooks/useAIChatLogic'
import { supabase } from './lib/supabase'
import { syncGoogleTokens } from './utils/auth'
import { normalizeHAUrl, sanitizeHAToken, callHAService, fetchWithTimeout } from './utils/home-assistant'
import { saveHAAutomation } from './utils/ha-api'
import { logger } from './utils/logger'
import './App.css'

interface TimerPluginInterface {
  setAlarm(options: { hour: number; minute: number; message?: string; days?: number[] }): Promise<{ success: boolean }>
}
const TimerPlugin = registerPlugin<TimerPluginInterface>('TimerPlugin')

// Global state for shared text (kept for backwards compatibility)
export let sharedTextForTranslation: string | null = null
export const clearSharedText = () => { sharedTextForTranslation = null }

function App() {
  const { user, loading, connections, activeConnection, setActiveConnection, deleteConnection, setShouldTriggerVoice } = useApp()
  const [showConnectionModal, setShowConnectionModal] = useState(false)
  const [showConnectionDropdown, setShowConnectionDropdown] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showGraphs, setShowGraphs] = useState(false)
  const dashboardRef = useRef<DashboardRef>(null)
  const [pendingSuggestions, setPendingSuggestions] = useState<any[]>([])
  const userDisconnectedRef = useRef(false)

  // Theme State (guarded localStorage)
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('app-theme') || 'dark' } catch { return 'dark' }
  })

  // AI Section Resize State - Default to ~35% of screen height
  const [aiSectionHeight, setAiSectionHeight] = useState(() => {
    if (typeof window !== 'undefined') {
      return Math.floor(window.innerHeight * 0.35)
    }
    return 300
  })
  const isResizingAi = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(0)

  const handleResizeStart = (clientY: number) => {
    isResizingAi.current = true
    startY.current = clientY
    startHeight.current = aiSectionHeight
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    const onMove = (clientY: number) => {
      if (!isResizingAi.current) return
      const delta = clientY - startY.current
      const newHeight = Math.max(200, Math.min(window.innerHeight * 0.8, startHeight.current + delta))
      setAiSectionHeight(newHeight)
    }
    const onMouseMove = (e: MouseEvent) => onMove(e.clientY)
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches && e.touches.length > 0) onMove(e.touches[0].clientY)
    }
    const onEnd = () => {
      isResizingAi.current = false
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)

    return () => {
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  useEffect(() => {
    document.body.classList.remove('theme-light', 'theme-midnight', 'theme-amoled')
    if (theme !== 'dark') document.body.classList.add(`theme-${theme}`)
    try { localStorage.setItem('app-theme', theme) } catch { }
  }, [theme])

  // Deep Link Listener (Widget Support & Auth Callback — redacts OAuth tokens from logs & supports PKCE + Implicit)
  useEffect(() => {
    const handleDeepLink = async (url: string) => {
      const safeLogUrl = url.split('#')[0].split('?')[0]
      logger.info('📱 Deep Link Opened:', safeLogUrl)

      // 1. Voice Widget
      if (url.includes('butler://voice')) {
        logger.info('🎤 Triggering Voice Mode')
        setShouldTriggerVoice(true)
        return
      }

      // 2. Auth Callback (Google OAuth — supports both PKCE ?code= and Implicit #access_token=)
      if (url.includes('butler://auth/callback')) {
        logger.info('🔐 Auth Callback detected')
        if (Capacitor.isNativePlatform()) {
          Browser.close().catch(() => {})
        }

        try {
          const parsedUrl = new URL(url.replace(/^butler:\/\//, 'https://butler.local/'))
          const errorParam = parsedUrl.searchParams.get('error_description') || parsedUrl.searchParams.get('error')
          if (errorParam) {
            logger.error('❌ OAuth callback error', errorParam)
            alert(`Google autorisatie mislukt: ${errorParam}`)
            return
          }

          // PKCE code flow
          const authCode = parsedUrl.searchParams.get('code')
          if (authCode) {
            const { data, error } = await supabase.auth.exchangeCodeForSession(authCode)
            if (error) {
              logger.error('❌ PKCE exchange failed', error)
              alert('Autorisatie mislukt: ' + error.message)
              return
            }
            if (data.session?.provider_token) {
              await syncGoogleTokens(data.session)
            }
            logger.info('✅ PKCE Session restored from deep link!')
            return
          }

          // Implicit hash flow
          const hashIndex = url.indexOf('#')
          if (hashIndex !== -1) {
            const params = new URLSearchParams(url.substring(hashIndex + 1))
            const access_token = params.get('access_token')
            const refresh_token = params.get('refresh_token')
            const provider_token = params.get('provider_token')
            const provider_refresh_token = params.get('provider_refresh_token')

            if (access_token && refresh_token) {
              const { data, error } = await supabase.auth.setSession({
                access_token,
                refresh_token
              })
              if (error) {
                logger.error('❌ Failed to set session', error)
                alert('Autorisatie mislukt: ' + error.message)
                return
              }
              if (data.session && provider_token) {
                const syncRes = await syncGoogleTokens(data.session, {
                  access_token: provider_token,
                  refresh_token: provider_refresh_token || undefined
                })
                if (!syncRes.success) {
                  logger.warn('⚠️ Google token sync warning:', syncRes.error)
                }
              }
              logger.info('✅ Session restored from deep link!')
            }
          }
        } catch (e: any) {
          logger.error('❌ Deep link auth parsing error', e)
        }
      }
    }

    CapacitorApp.getLaunchUrl().then(launchUrl => {
      if (launchUrl?.url) handleDeepLink(launchUrl.url)
    }).catch(() => {})

    const listener = CapacitorApp.addListener('appUrlOpen', (data: any) => {
      if (data?.url) handleDeepLink(data.url)
    })

    return () => {
      listener.then(l => l.remove()).catch(() => {})
    }
  }, [setShouldTriggerVoice])

  // Wire up graph creation callback with live refresh event
  useEffect(() => {
    setGraphCreateCallback((config: any) => {
      try {
        const STORAGE_KEY = 'butler_graphs'
        const stored = localStorage.getItem(STORAGE_KEY)
        const graphs = stored ? JSON.parse(stored) : []
        const safeGraphs = Array.isArray(graphs) ? graphs : []

        const newGraph = {
          ...config,
          id: `graph_${Date.now()}`,
          createdAt: Date.now()
        }

        const updated = safeGraphs.length >= 5
          ? [...safeGraphs.slice(1), newGraph]
          : [...safeGraphs, newGraph]

        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
        window.dispatchEvent(new CustomEvent('butler-graphs-updated', { detail: updated }))
        setShowGraphs(true)
        logger.info('📊 Graph created and navigating to Graphs page')
      } catch (e) {
        logger.error('❌ Failed to create graph', e)
      }
    })
    return () => setGraphCreateCallback(null as any)
  }, [])

  // Auto-select first connection only on initial load (never override explicit user Disconnect!)
  useEffect(() => {
    if (connections.length > 0 && !activeConnection && !userDisconnectedRef.current) {
      setActiveConnection(connections[0])
    }
  }, [connections, activeConnection, setActiveConnection])

  // Connection-scoped Push, Ghost Runner & Background Action Listener
  const activeConnId = activeConnection?.id || null
  const activeConnUrl = activeConnection?.api_url || ''
  const activeConnToken = activeConnection?.api_token || ''

  useEffect(() => {
    if (!activeConnId) {
      setActionListener(null)
      setSuggestionsListener(null)
      return
    }

    registerPushNotifications(activeConnId)

    const cleanApiUrl = normalizeHAUrl(activeConnUrl)
    const cleanToken = sanitizeHAToken(activeConnToken)

    // Bootstrap Ghost Runner script idempotently
    const bootstrapGhostRunner = async () => {
      if (!cleanApiUrl || !cleanToken) return
      try {
        const ghostScript = {
          alias: 'AI Ghost Runner',
          mode: 'parallel',
          icon: 'mdi:ghost',
          fields: {
            delay: { description: 'Time to wait (HH:MM:SS)', example: '00:00:30' },
            service: { description: 'Service to call', example: 'light.turn_on' },
            entity: { description: 'Entity ID', example: 'light.kitchen' }
          },
          sequence: [
            { delay: '{{ delay }}' },
            { service: '{{ service }}', target: { entity_id: '{{ entity }}' } }
          ]
        }

        const res = await fetchWithTimeout(`${cleanApiUrl}/api/config/script/config/ai_ghost_runner`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cleanToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(ghostScript)
        }, 10000)

        if (res.ok) {
          logger.info('👻 Ghost Runner Configured: script.ai_ghost_runner')
        } else {
          logger.warn(`Ghost Runner setup returned HTTP ${res.status}`)
        }
      } catch (e) {
        logger.warn('Failed to bootstrap Ghost Runner (non-critical):', e)
      }
    }
    bootstrapGhostRunner()

    setActionListener(async (actions: any[]) => {
      logger.info('⚡ Global Action Listener Triggered', { count: actions?.length })
      const flatActions = actions.flatMap(a => (a && Array.isArray(a.actions)) ? a.actions : [a])

      await Promise.allSettled(flatActions.map(async (action) => {
        if (!action) return
        try {
          if (action.type === 'set_alarm') {
            const { hour, minute, message, days } = action.data || {}
            if (typeof hour !== 'number' || typeof minute !== 'number' || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
              logger.error('Invalid alarm data', action.data)
              return
            }
            if (Capacitor.isNativePlatform()) {
              await TimerPlugin.setAlarm({ hour, minute, message: message || 'Butler Wekker', days })
              logger.info('✅ Native Alarm Set via TimerPlugin')
            }
            return
          }

          if (action.type === 'create_automation' && action.data) {
            await saveHAAutomation(cleanApiUrl, cleanToken, action.data)
            return
          }

          if (!action.entity_id) return
          const entityStr = Array.isArray(action.entity_id) ? action.entity_id[0] : String(action.entity_id)
          let domain = entityStr.split('.')[0]
          let service = action.service

          if (service && service.includes('.')) {
            const parts = service.split('.')
            domain = parts[0]
            service = parts[1]
          } else if (!service && action.type && action.type.includes('.')) {
            const parts = action.type.split('.')
            domain = parts[0]
            service = parts[1]
          }

          if (!domain || !service) {
            logger.warn('Action missing domain/service', action)
            return
          }

          const payload: Record<string, any> = { ...(action.data || {}) }
          if (domain !== 'script' || ['turn_on', 'turn_off', 'toggle', 'reload'].includes(service)) {
            payload.entity_id = action.entity_id
          }

          await callHAService(domain, service, payload, cleanApiUrl, cleanToken)
        } catch (e: any) {
          logger.error('❌ Background Action Failed', { message: e?.message || String(e) })
        }
      }))
    })

    setSuggestionsListener(async () => {
      const { data, error } = await supabase
        .from('suggestions')
        .select('*')
        .eq('connection_id', activeConnId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })

      if (error) {
        logger.error('Failed to load suggestions', error)
        return
      }
      if (data && data.length > 0) {
        setPendingSuggestions(data)
        logger.info(`📋 Loaded ${data.length} suggestions from notification tap`)
      }
    })

    return () => {
      setActionListener(null)
      setSuggestionsListener(null)
    }
  }, [activeConnId, activeConnUrl, activeConnToken])

  const handleDeleteConnection = async (e: React.MouseEvent, connId: string) => {
    e.stopPropagation()
    if (window.confirm('Weet je zeker dat je deze verbinding wilt verwijderen?')) {
      try {
        await deleteConnection(connId)
        logger.info(`Deleted connection: ${connId}`)
      } catch (err: any) {
        logger.error('Failed to delete connection', { id: connId, error: err?.message })
        alert(`Verwijderen mislukt: ${err?.message || 'Onbekende fout'}`)
      }
    }
  }

  const handleExecutePendingSuggestion = async (id: string, decision: 'accept' | 'reject') => {
    const target = pendingSuggestions.find(s => s.id === id)
    if (decision === 'accept' && target && activeConnection) {
      const cleanUrl = normalizeHAUrl(activeConnection.api_url)
      const cleanToken = sanitizeHAToken(activeConnection.api_token)

      try {
        if (target.ha_automation && typeof target.ha_automation === 'object') {
          await saveHAAutomation(cleanUrl, cleanToken, target.ha_automation)
        } else if (Array.isArray(target.actions)) {
          for (const act of target.actions) {
            if (act?.type === 'create_automation' && act.data) {
              await saveHAAutomation(cleanUrl, cleanToken, act.data)
            } else if (act?.entity_id && act?.service) {
              const parts = act.service.includes('.') ? act.service.split('.') : [act.entity_id.split('.')[0], act.service]
              await callHAService(parts[0], parts[1], { ...(act.data || {}), entity_id: act.entity_id }, cleanUrl, cleanToken)
            }
          }
        }
      } catch (err: any) {
        logger.error('❌ Failed executing accepted suggestion', err)
        alert(`Kon suggestie niet uitvoeren: ${err?.message || 'Onbekende fout'}`)
        return
      }
    }

    const { error } = await supabase
      .from('suggestions')
      .update({ status: decision === 'accept' ? 'accepted' : 'rejected' })
      .eq('id', id)

    if (error) {
      logger.error('Failed updating suggestion status', error)
    }
    setPendingSuggestions(prev => prev.filter(s => s.id !== id))
  }

  if (loading) {
    return <div className="loading">Laden...</div>
  }

  if (!user) {
    return <Auth onAuthSuccess={() => { }} />
  }

  return (
    <div className="app-container" style={{ flexDirection: 'column' }}>
      {/* Hypermodern Dynamic Island Header */}
      <header className="dynamic-island-header">
        <div className="header-brand" onClick={() => setShowConnectionDropdown(!showConnectionDropdown)}>
          <div className="brand-orb">⚡</div>
          <h1 className="brand-title">Butler</h1>
        </div>

        <div style={{ position: 'relative' }}>
          <div className="connection-capsule" onClick={() => setShowConnectionDropdown(!showConnectionDropdown)}>
            <div className={`status-dot ${activeConnection ? '' : 'disconnected'}`} />
            <span className="name">{activeConnection ? activeConnection.name : 'Geen verbinding'}</span>
            <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>▼</span>
          </div>

          {showConnectionDropdown && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)',
              background: 'var(--bg-elevated)', border: 'var(--glass-border)', borderRadius: '16px',
              zIndex: 1000, minWidth: '220px', overflow: 'hidden', boxShadow: 'var(--shadow-lg)',
              backdropFilter: 'blur(24px)'
            }}>
              <div style={{ padding: '10px 14px', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: 'var(--glass-border)' }}>
                Home Assistant Verbindingen
              </div>
              {connections.map(c => (
                <div key={c.id} onClick={() => { userDisconnectedRef.current = false; setActiveConnection(c); setShowConnectionDropdown(false); }}
                  style={{
                    padding: '10px 14px', cursor: 'pointer', borderBottom: 'var(--glass-border)',
                    fontSize: '0.9rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: activeConnection?.id === c.id ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                    color: activeConnection?.id === c.id ? '#a5b4fc' : 'var(--text-primary)'
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div className="status-dot" />
                    <span>{c.name}</span>
                  </div>
                  <button onClick={(e) => handleDeleteConnection(e, c.id)}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', fontSize: '0.9rem' }}
                    title="Verwijder">
                    🗑️
                  </button>
                </div>
              ))}
              <div onClick={() => { setShowConnectionModal(true); setShowConnectionDropdown(false); }}
                style={{ padding: '10px 14px', cursor: 'pointer', background: 'rgba(255,255,255,0.03)', fontSize: '0.85rem', color: 'var(--accent-light)', textAlign: 'center', fontWeight: 600 }}>
                + Nieuwe Verbinding Toevoegen
              </div>
            </div>
          )}
        </div>

        <div className="header-actions">
          {activeConnection && (
            <button className="header-icon-btn" onClick={() => dashboardRef.current?.importLayoutFromHA()} title="Synchroniseer Home Assistant Layout">
              ↻
            </button>
          )}

          <button className="header-icon-btn" onClick={() => setShowGraphs(true)} title="Grafieken">
            📊
          </button>

          <button className="header-icon-btn" onClick={() => setShowSettings(true)} title="Instellingen">
            ⚙️
          </button>

          {activeConnection && (
            <button
              className="header-icon-btn"
              onClick={() => {
                userDisconnectedRef.current = true
                setActiveConnection(null)
              }}
              title="Ontkoppelen"
              style={{ color: '#ef4444' }}
            >
              ✕
            </button>
          )}
        </div>
      </header>

      <div className="main-content">
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
              <h2 style={{ fontSize: '1.2rem', margin: 0, color: 'var(--text-primary)' }}>Butler AI</h2>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <AIChat />
            </div>
            <div
              className="ai-resize-handle"
              onMouseDown={(e) => handleResizeStart(e.clientY)}
              onTouchStart={(e) => {
                if (e.touches && e.touches.length > 0) handleResizeStart(e.touches[0].clientY)
              }}
            >
              <div className="handle-bar" />
            </div>
          </div>
        </div>

        <div className="dashboard">
          {activeConnection && <Dashboard ref={dashboardRef} />}

          {!activeConnection && (
            <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <p>Geen Home Assistant verbinding actief.</p>
              <button onClick={() => setShowConnectionModal(true)} style={{ marginTop: '16px' }}>
                + Verbinding Toevoegen
              </button>
            </div>
          )}
        </div>
      </div>

      {showConnectionModal && (
        <div className="modal-overlay" onClick={() => setShowConnectionModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2>Home Assistant Koppelen</h2>
            <ConnectionSetup onConnectionAdded={() => { userDisconnectedRef.current = false; setShowConnectionModal(false); }} />
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '460px' }}>
            <Settings onClose={() => setShowSettings(false)} />
          </div>
        </div>
      )}

      {showGraphs && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'var(--bg-primary)', overflow: 'auto' }}>
          <Graphs onBack={() => setShowGraphs(false)} />
        </div>
      )}

      <ButlerSuggestions />

      {pendingSuggestions.length > 0 && (
        <SuggestionPopup
          suggestions={pendingSuggestions}
          onClose={() => setPendingSuggestions([])}
          onAction={handleExecutePendingSuggestion}
        />
      )}
    </div>
  )
}

export default App