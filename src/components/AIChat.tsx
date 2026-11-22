import React, { useEffect, useRef, useState } from 'react'
import { registerPlugin } from '@capacitor/core'
import { useApp } from '../lib/AppContext'
import { useAIChatLogic } from '../lib/hooks/useAIChatLogic'
import { useDeepgramVoice } from '../lib/hooks/useDeepgramVoice'
import { supabase } from '../lib/supabase'
import { saveHAAutomation, manageHATodoItem } from '../utils/ha-api'

// @ts-ignore
import { logger } from '../utils/logger'

// FloatingButton plugin interface for checking voice input intent
interface FloatingButtonPlugin {
  checkPendingVoiceInput(): Promise<{ pending: boolean }>;
}

const FloatingButton = registerPlugin<FloatingButtonPlugin>('FloatingButton');

interface AIChatProps {
  disableGlobalVoiceListeners?: boolean;
}

export function AIChat({ disableGlobalVoiceListeners = false }: AIChatProps = {}) {
  const { activeConnection, uiState, shouldTriggerVoice, setShouldTriggerVoice } = useApp()
  const { messages, setMessages, sendMessage, loading, conversationMode } = useAIChatLogic()
  const [inputText, setInputText] = useState('')
  const [completedTodos, setCompletedTodos] = useState<Record<string, boolean>>({})
  const [activatedAutomations, setActivatedAutomations] = useState<Record<string, boolean>>({})
  const [activatingAutomations, setActivatingAutomations] = useState<Record<string, boolean>>({})
  const [copiedYaml, setCopiedYaml] = useState<string | null>(null)
  const [expandedYaml, setExpandedYaml] = useState<Record<string, boolean>>({})
  const chatEndRef = useRef<HTMLDivElement>(null)

  const { isListening, isStarting, partialTranscript, startListening, stopListening, error: voiceError, isWhisper } = useDeepgramVoice({
    language: uiState.language,
    onTranscript: (text) => setInputText(text),
    onFinalTranscript: (text) => {
      const wasWhispering = isWhisper;
      setInputText('');
      sendMessage(text, { isWhisper: wasWhispering });
    }
  });

  // Global Voice Trigger (Deep Links / Widget) — only active on primary AIChat instance
  useEffect(() => {
    if (disableGlobalVoiceListeners) return;
    if (shouldTriggerVoice) {
      if (!isListening && !isStarting) {
        logger.info('🎙️ Global Voice Trigger Activated');
        startListening();
      }
      setShouldTriggerVoice(false);
    }
  }, [disableGlobalVoiceListeners, shouldTriggerVoice, isListening, isStarting, startListening, setShouldTriggerVoice]);

  useEffect(() => {
    const timer = setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, 100);
    return () => clearTimeout(timer);
  }, [messages, partialTranscript, loading])

  // Check for pending voice input on mount (from floating button tap)
  useEffect(() => {
    if (disableGlobalVoiceListeners || !activeConnection) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const checkPendingVoice = async () => {
      try {
        const result = await FloatingButton.checkPendingVoiceInput();
        if (result.pending) {
          timer = setTimeout(() => startListening(), 500);
        }
      } catch { }
    };
    checkPendingVoice();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [disableGlobalVoiceListeners, activeConnection?.id]);

  // Conversation Mode: Auto-listen after TTS finishes
  useEffect(() => {
    if (disableGlobalVoiceListeners) return;
    const handleAutoListen = () => {
      if (!isListening && !loading) {
        startListening();
      }
    };
    window.addEventListener('butler-auto-listen', handleAutoListen);
    return () => window.removeEventListener('butler-auto-listen', handleAutoListen);
  }, [disableGlobalVoiceListeners, isListening, loading, startListening]);

  // Load History with cancellation guard
  useEffect(() => {
    if (!activeConnection?.id) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const loadHistory = async () => {
      const { data } = await supabase
        .from('chat_history')
        .select('*')
        .eq('connection_id', activeConnection.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (cancelled || !Array.isArray(data)) return;

      const mapped = [...data].reverse().map((d: any) => {
        let aiText = '';
        if (typeof d.ai_response === 'string') {
          try {
            const parsed = JSON.parse(d.ai_response);
            aiText = parsed.text || (parsed.actions && parsed.actions.length > 0 ? 'Actie uitgevoerd.' : '');
          } catch {
            aiText = d.ai_response;
          }
        } else if (d.ai_response && typeof d.ai_response === 'object') {
          aiText = d.ai_response.text || (d.ai_response.actions && d.ai_response.actions.length > 0 ? 'Actie uitgevoerd.' : '');
        }
        if (!aiText && d.actions_taken && d.actions_taken.length > 0) {
          aiText = 'Actie uitgevoerd.';
        }
        return {
          id: d.id,
          connection_id: d.connection_id,
          user_message: d.user_message,
          ai_response: aiText,
          language: d.language || d.metadata?.language || 'nl',
          actions_taken: d.actions_taken || [],
          created_at: d.created_at
        };
      });
      setMessages(mapped as any);
    };
    loadHistory();
    return () => { cancelled = true; };
  }, [activeConnection?.id, setMessages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || loading) return;
    const toSend = inputText;
    setInputText('');
    sendMessage(toSend);
  };

  const handleToggleTodo = async (listEntityId: string, itemSummary: string) => {
    const key = `${listEntityId}_${itemSummary}`;
    const prevState = !!completedTodos[key];
    const nextState = !prevState;
    setCompletedTodos(prev => ({ ...prev, [key]: nextState }));

    const apiUrl = activeConnection?.api_url;
    const apiToken = activeConnection?.api_token || activeConnection?.token;
    if (apiUrl && apiToken) {
      try {
        await manageHATodoItem(apiUrl, apiToken, 'update', {
          listEntityId: listEntityId || 'todo.shopping_list',
          item: itemSummary,
          status: nextState ? 'completed' : 'needs_action'
        });
      } catch (err: any) {
        // Revert optimistic update on error
        setCompletedTodos(prev => ({ ...prev, [key]: prevState }));
        logger.error('Failed to update todo item:', err);
      }
    }
  };

  const handleActivateAutomation = async (autoData: any) => {
    if (!autoData?.id || activatingAutomations[autoData.id] || activatedAutomations[autoData.id]) return;
    const apiUrl = activeConnection?.api_url;
    const apiToken = activeConnection?.api_token || activeConnection?.token;
    if (!apiUrl || !apiToken) {
      alert('Geen actieve Home Assistant verbinding met token.');
      return;
    }

    setActivatingAutomations(prev => ({ ...prev, [autoData.id]: true }));
    try {
      await saveHAAutomation(apiUrl, apiToken, autoData);
      setActivatedAutomations(prev => ({ ...prev, [autoData.id]: true }));
    } catch (err: any) {
      alert(`Activeren mislukt: ${err?.message || 'Onbekende fout'}`);
    } finally {
      setActivatingAutomations(prev => ({ ...prev, [autoData.id]: false }));
    }
  };

  const handleCopyYaml = async (autoData: any) => {
    const cleanConfig = {
      alias: autoData.alias || 'Butler Automatisering',
      description: autoData.description || '',
      trigger: autoData.trigger || [],
      condition: autoData.condition || [],
      action: autoData.action || [],
      mode: autoData.mode || 'single'
    };
    // Valid JSON is 100% valid YAML 1.2 in Home Assistant
    const yamlText = JSON.stringify(cleanConfig, null, 2);
    try {
      await navigator.clipboard.writeText(yamlText);
      setCopiedYaml(autoData.id);
      setTimeout(() => setCopiedYaml(null), 3000);
    } catch {
      alert('Kon niet naar klembord kopiëren op dit apparaat.');
    }
  };

  if (!activeConnection) return <div className="chat-empty">Kies een verbinding om te beginnen met chatten</div>

  return (
    <div className="ai-chat" style={{ position: 'relative' }}>
      {/* Sleek Floating Hands-Free Mode Indicator */}
      {conversationMode && (
        <div style={{
          position: 'absolute',
          top: '8px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10,
          background: 'rgba(16, 185, 129, 0.2)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(16, 185, 129, 0.4)',
          color: '#34d399',
          padding: '4px 12px',
          borderRadius: '16px',
          fontSize: '11px',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          boxShadow: '0 2px 10px rgba(16, 185, 129, 0.2)'
        }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981' }} />
          Hands-Free Modus Actief
        </div>
      )}

      <div className="chat-messages">
        {messages.map((msg) => (
          <React.Fragment key={msg.id}>
            {/* 1. User Message */}
            {msg.user_message && (
              <div className="message-group">
                <div className="message user">
                  <p>{msg.user_message}</p>
                </div>
              </div>
            )}

            {/* 2. AI Response */}
            <div className="message-group">
              <div className="message ai">
                {msg.ai_response ? (
                  <p>
                    {(() => {
                      try {
                        if (msg.ai_response.trim().startsWith('{')) {
                          const parsed = JSON.parse(msg.ai_response);
                          return parsed.text || msg.ai_response;
                        }
                      } catch (e) { }
                      return msg.ai_response;
                    })()}
                  </p>
                ) : (
                  <div className="typing-indicator">
                    <span>.</span><span>.</span><span>.</span>
                  </div>
                )}

                {/* 3. Rich Action Widgets */}
                {(() => {
                  let actions = msg.actions_taken;
                  let scheduled = msg.scheduled_actions;
                  if ((!actions || actions.length === 0) && msg.ai_response?.trim().startsWith('{')) {
                    try {
                      const parsed = JSON.parse(msg.ai_response);
                      actions = parsed.actions || [];
                      scheduled = parsed.scheduled_actions || [];
                    } catch (e) { }
                  }

                  if (!actions && !scheduled) return null;

                  // Filter out gas energy cards if an electricity card is present in the same message
                  const hasElectricityAction = actions?.some((act: any) => 
                    act.type === 'energy' && (act.data?.energy_type === 'electricity' || act.data?.unit?.includes('kWh') || (!act.data?.unit?.includes('m³') && !act.data?.unit?.includes('m3')))
                  );
                  const displayActions = actions?.filter((act: any) => {
                    if (act.type === 'energy' && hasElectricityAction) {
                      const isGas = act.data?.energy_type === 'gas' || act.data?.unit?.includes('m³') || act.data?.unit?.includes('m3') || (act.data?.source && act.data?.source.toLowerCase().includes('gas'));
                      if (isGas) return false;
                    }
                    return true;
                  });

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
                      {displayActions?.map((a: any, i: number) => {
                        // A. Weather Widget Card
                        if (a.type === 'weather' && a.data?.current) {
                          const cur = a.data.current;
                          const temp = cur.temperature_c ?? cur.temperature;
                          const desc = cur.condition_nl || cur.weather_description || 'Weersoverzicht';
                          const wind = cur.wind_speed_kmh ?? cur.wind_speed;
                          const gusts = cur.wind_gusts_kmh ?? cur.wind_gusts;
                          const dew = cur.dew_point_c ?? cur.dew_point;
                          const hum = cur.relative_humidity;
                          const rain = cur.precipitation_mm ?? cur.precipitation;
                          const isDay = cur.is_day ?? (new Date().getHours() >= 7 && new Date().getHours() < 22);

                          return (
                            <div key={i} className="chat-widget-card weather-widget">
                              <div className="weather-header">
                                <div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    {a.data.location?.requested_name || a.data.location?.name || 'Huidige Locatie'}
                                  </div>
                                  <div className="weather-temp">{temp !== undefined ? `${temp}°C` : '–'}</div>
                                </div>
                                <div style={{ fontSize: '2rem' }}>
                                  {isDay ? '☀️' : '🌙'}
                                </div>
                              </div>
                              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {desc}
                              </div>
                              <div className="weather-badges">
                                {wind !== undefined && <span className="weather-chip">💨 {wind} km/h{gusts ? ` (stoten ${gusts} km/h)` : ''}</span>}
                                {dew !== undefined && <span className="weather-chip">💧 Dauwpunt {dew}°C</span>}
                                {hum !== undefined && <span className="weather-chip">💦 Vocht {hum}%</span>}
                                {rain > 0 && (
                                  <span className="weather-chip" style={{ color: '#60a5fa' }}>🌧️ {rain} mm</span>
                                )}
                              </div>
                            </div>
                          );
                        }

                        // B. Energy Spot Price Widget Card
                        if (a.type === 'energy' && (a.data?.hourly_prices_today || a.data?.hourly_curve_today || a.data?.current_price !== undefined)) {
                          const unit = a.data.unit || '€/kWh';
                          const isGas = a.data?.energy_type === 'gas' || unit.includes('m³') || unit.includes('m3') || (a.data.source && a.data.source.toLowerCase().includes('gas'));
                          const priceTitle = isGas ? 'Gasprijs' : 'Stroomprijs';
                          const curPrice = a.data.current_price;
                          const hourly = a.data.hourly_prices_today || a.data.hourly_curve_today || [];
                          const cheapestObj = Array.isArray(a.data.cheapest_hours_today) && a.data.cheapest_hours_today.length > 0
                            ? a.data.cheapest_hours_today[0]
                            : a.data.cheapest_slot_today;
                          const cheapestTime = cheapestObj?.hour || cheapestObj?.time;
                          const cheapestPrice = cheapestObj?.price;
                          const avgPrice = a.data.average_price_today ?? a.data.today_summary?.average;

                          return (
                            <div key={i} className="chat-widget-card energy-widget">
                              <div className="energy-summary-row">
                                <div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                    {priceTitle} ({a.data.source || a.data.provider || 'EPEX Spot'})
                                  </div>
                                  <div className="energy-current-price">
                                    {curPrice !== undefined ? Number(curPrice).toFixed(3) : '–'} {unit}
                                  </div>
                                </div>
                                {cheapestTime && (
                                  <div className="energy-cheapest-pill">
                                    🏷️ Goedkoopst: {cheapestTime} ({cheapestPrice !== undefined ? Number(cheapestPrice).toFixed(3) : ''} {unit})
                                  </div>
                                )}
                              </div>

                              {Array.isArray(hourly) && hourly.length > 0 && (
                                <div>
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                    24-uurs prijscurve vandaag
                                  </div>
                                  <div className="energy-bars-container">
                                    {(() => {
                                      const prices = hourly.map((h: any) => Number(h?.price)).filter((p: number) => Number.isFinite(p));
                                      const minP = prices.length > 0 ? Math.min(...prices) : 0;
                                      const maxP = prices.length > 0 ? Math.max(...prices) : 0.5;
                                      const range = Math.max(0.01, maxP - minP);
                                      const currentHourPrefix = `${new Date().getHours().toString().padStart(2, '0')}:`;

                                      return hourly.map((h: any, idx: number) => {
                                        const hTime = String(h?.hour || h?.time || `${idx.toString().padStart(2, '0')}:00`);
                                        const hPrice = Number(h?.price);
                                        if (!Number.isFinite(hPrice)) return null;
                                        const normalized = Math.max(0.15, (hPrice - minP) / range);
                                        const heightPercent = Math.round(normalized * 100);
                                        const isCurrent = hTime.startsWith(currentHourPrefix);
                                        const isCheapest = hTime === cheapestTime;
                                        const isAboveAvg = avgPrice !== undefined && hPrice > avgPrice;
                                        const bg = isCheapest ? '#10b981' : isCurrent ? '#6366f1' : isAboveAvg ? '#ef4444' : '#3b82f6';

                                        return (
                                          <div key={idx} className="energy-bar-col" title={`${hTime}: ${hPrice.toFixed(3)} ${unit}`}>
                                            <div className="energy-bar-fill" style={{ height: `${heightPercent}%`, background: bg, opacity: isCurrent || isCheapest ? 1 : 0.65 }} />
                                          </div>
                                        );
                                      });
                                    })()}
                                  </div>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                    <span>00:00</span>
                                    <span>12:00</span>
                                    <span>23:00</span>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        }

                        // C. Camera Snapshot Widget
                        if (a.type === 'camera' && a.data?.snapshot_data_url) {
                          return (
                            <div key={i} className="camera-widget">
                              <img src={a.data.snapshot_data_url} alt="Camera snapshot" className="camera-img" />
                              <div className="camera-overlay">
                                <div className="camera-live-badge">
                                  <span className="camera-live-dot" />
                                  <span>{a.entity_id}</span>
                                </div>
                                <span style={{ opacity: 0.8 }}>Live Snapshot</span>
                              </div>
                            </div>
                          );
                        }

                        // D. Todo Checklist Widget
                        if (a.type === 'todo' && a.data && a.data.action !== 'remove') {
                          const listId = a.data.list_entity_id || a.entity_id || 'todo.shopping_list';
                          return (
                            <div key={i} className="chat-widget-card todo-widget">
                              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#a5b4fc', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span>📋</span>
                                <span>{listId}</span>
                              </div>
                              {Array.isArray(a.data.pending_items) && a.data.pending_items.length > 0 ? (
                                a.data.pending_items.map((item: any, idx: number) => {
                                  const itemText = typeof item === 'string' ? item : item.summary;
                                  const isDone = completedTodos[`${listId}_${itemText}`];
                                  return (
                                    <div key={idx} className="todo-row" onClick={() => handleToggleTodo(listId, itemText)}>
                                      <div className={`todo-checkbox-box ${isDone ? 'checked' : ''}`}>
                                        {isDone ? '✓' : ''}
                                      </div>
                                      <span className={`todo-text ${isDone ? 'checked' : ''}`}>{itemText}</span>
                                    </div>
                                  );
                                })
                              ) : a.data.item ? (
                                <div className="todo-row" onClick={() => handleToggleTodo(listId, a.data.item)}>
                                  <div className={`todo-checkbox-box ${completedTodos[`${listId}_${a.data.item}`] || a.data.action === 'complete' ? 'checked' : ''}`}>
                                    {completedTodos[`${listId}_${a.data.item}`] || a.data.action === 'complete' ? '✓' : ''}
                                  </div>
                                  <span className={`todo-text ${completedTodos[`${listId}_${a.data.item}`] || a.data.action === 'complete' ? 'checked' : ''}`}>{a.data.item}</span>
                                </div>
                              ) : null}
                            </div>
                          );
                        }

                        // E. Calendar Widget (with date + time & Invalid Date safety)
                        if (a.type === 'calendar' && Array.isArray(a.data?.events) && a.data.events.length > 0) {
                          return (
                            <div key={i} className="chat-widget-card" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span>📅</span>
                                <span>Afspraken & Kalender</span>
                              </div>
                              {a.data.events.slice(0, 6).map((ev: any, idx: number) => {
                                const rawStart = String(ev?.start || '');
                                const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawStart);
                                const d = rawStart ? new Date(isDateOnly ? `${rawStart}T12:00:00` : rawStart) : null;
                                const timeLabel = d && !isNaN(d.getTime())
                                  ? (isDateOnly
                                    ? d.toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short' })
                                    : d.toLocaleString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))
                                  : rawStart;
                                return (
                                  <div key={idx} style={{ padding: '6px 8px', background: 'rgba(255,255,255,0.04)', borderRadius: '8px', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{ev.summary}</span>
                                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{timeLabel}</span>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        }

                        // F. Automation Preview Card Widget
                        if (a.type === 'automation' && a.data) {
                          const isActivating = !!activatingAutomations[a.data.id];
                          const isActivated = !!activatedAutomations[a.data.id];
                          return (
                            <div key={i} className="chat-widget-card automation-widget">
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div>
                                  <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#c084fc', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span>⚡</span>
                                    <span>{a.data.alias || 'Nieuwe Automatisering'}</span>
                                  </div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                                    {a.data.description}
                                  </div>
                                </div>
                                <button onClick={() => setExpandedYaml(prev => ({ ...prev, [a.data.id]: !prev[a.data.id] }))}
                                  style={{ background: 'none', border: 'none', color: '#a5b4fc', fontSize: '0.75rem', cursor: 'pointer' }}>
                                  {expandedYaml[a.data.id] ? 'Verberg JSON/YAML' : 'Bekijk config'}
                                </button>
                              </div>

                              {expandedYaml[a.data.id] && (
                                <pre className="automation-yaml-toggle">
                                  {JSON.stringify({
                                    alias: a.data.alias,
                                    trigger: a.data.trigger,
                                    condition: a.data.condition,
                                    action: a.data.action
                                  }, null, 2)}
                                </pre>
                              )}

                              <div className="automation-buttons-row">
                                <button className="btn-activate-ha"
                                  onClick={() => handleActivateAutomation(a.data)}
                                  disabled={isActivated || isActivating}>
                                  {isActivated ? '✅ Geactiveerd in HA!' : isActivating ? '⏳ Activeren...' : '⚡ Activeer in Home Assistant'}
                                </button>
                                <button className="btn-copy-yaml" onClick={() => handleCopyYaml(a.data)}>
                                  {copiedYaml === a.data.id ? '✓ Gekopieerd' : '📋 Kopieer'}
                                </button>
                              </div>
                            </div>
                          );
                        }

                        // G. Adaptive Deep Reasoning escalation badge
                        if (a.type === 'deep_reasoning' && a.data) {
                          const depthLabel = a.data.depth === 'high' ? 'Diep (High)' : 'Nauwkeurig (Medium)';
                          return (
                            <div
                              key={i}
                              className="action-badge"
                              style={{
                                alignSelf: 'flex-start',
                                background: 'rgba(139, 92, 246, 0.14)',
                                color: '#c4b5fd',
                                border: '1px solid rgba(139, 92, 246, 0.35)'
                              }}
                            >
                              🧠 Adaptief geëscaleerd → {a.data.model_used || 'Deep Reasoner'} ({depthLabel})
                            </div>
                          );
                        }

                        // H. Fallback for device actions / proactive workers / generic actions
                        const isError = a.result === 'error';
                        return (
                          <div
                            key={i}
                            className="action-badge"
                            style={{
                              alignSelf: 'flex-start',
                              ...(isError ? { background: 'rgba(239, 68, 68, 0.15)', color: '#fca5a5', border: '1px solid rgba(239, 68, 68, 0.35)' } : {})
                            }}
                          >
                            {isError ? '❌' : '✅'} {a.service || a.type} {a.entity_id || ''}
                          </div>
                        );
                      })}

                      {scheduled?.map((s: any, i: number) => (
                        <div key={i} className="action-badge" style={{ background: 'rgba(234, 179, 8, 0.15)', color: '#fbbf24', border: '1px solid rgba(234, 179, 8, 0.3)', alignSelf: 'flex-start' }}>
                          ⏰ {s.title} ({s.delay_seconds || Math.round((s.wait_ms || 0) / 1000)}s)
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          </React.Fragment>
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* Voice Error Banner */}
      {voiceError && (
        <div style={{ padding: '6px 12px', margin: '4px 12px', borderRadius: '10px', background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', fontSize: '0.78rem' }}>
          🎤 {voiceError}
        </div>
      )}

      {/* Voice Transcript & Listening Waveform Indicator */}
      {isListening && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '6px 0', background: 'rgba(239, 68, 68, 0.08)', borderRadius: '12px', margin: '4px 12px' }}>
          <div className="waveform-bars">
            <div className="waveform-bar" style={{ background: '#ef4444' }} />
            <div className="waveform-bar" style={{ background: '#ef4444' }} />
            <div className="waveform-bar" style={{ background: '#ef4444' }} />
            <div className="waveform-bar" style={{ background: '#ef4444' }} />
            <div className="waveform-bar" style={{ background: '#ef4444' }} />
          </div>
          <span style={{ fontSize: '0.8rem', color: '#ef4444', fontWeight: 600 }}>
            {partialTranscript ? `${isWhisper ? '🤫 ' : ''}${partialTranscript}` : 'Butler luistert...'}
          </span>
        </div>
      )}

      {/* Input Bar */}
      <form onSubmit={handleSubmit} className="chat-input-form">
        <div className="input-group">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Vraag Butler iets of tik op de microfoon..."
            disabled={false}
          />
          <button
            type="button"
            className={`voice-btn ${isListening ? 'listening' : ''} ${isStarting ? 'connecting' : ''}`}
            onClick={() => isListening ? stopListening('user_tap') : startListening()}
            disabled={isStarting}
            style={{ backgroundColor: isListening ? '#ef4444' : isStarting ? '#eab308' : undefined }}
            title={isListening ? 'Stop met luisteren' : 'Start spraakherkenning'}
          >
            {isListening ? '🛑' : isStarting ? '⏳' : '🎙️'}
          </button>
          <button type="submit" disabled={loading || !inputText.trim()}>
            {loading ? '...' : 'Verstuur'}
          </button>
        </div>
      </form>
    </div>
  )
}
