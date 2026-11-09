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

export function AIChat() {
  const { activeConnection } = useApp()
  const { messages, setMessages, sendMessage, loading, conversationMode } = useAIChatLogic()
  const [inputText, setInputText] = useState('')
  const [completedTodos, setCompletedTodos] = useState<Record<string, boolean>>({})
  const [activatedAutomations, setActivatedAutomations] = useState<Record<string, boolean>>({})
  const [copiedYaml, setCopiedYaml] = useState<string | null>(null)
  const [expandedYaml, setExpandedYaml] = useState<Record<string, boolean>>({})
  const chatEndRef = useRef<HTMLDivElement>(null)


  // --- RESTORED LOGIC ---



  // Voice Hook - Deepgram Nova-3 for high accuracy STT
  const { isListening, isStarting, partialTranscript, startListening, stopListening, error: voiceError, isWhisper, audioLevel } = useDeepgramVoice({
    onTranscript: (text) => setInputText(text),
    onFinalTranscript: (text) => {
      // Capture whisper state at time of final transcript
      const wasWhispering = isWhisper;
      setInputText(text);
      sendMessage(text, { isWhisper: wasWhispering });
      setInputText(''); // Clear input after AutoSend
    }
  });

  // Global Voice Trigger (Deep Links / Widget)
  const { shouldTriggerVoice, setShouldTriggerVoice } = useApp();
  useEffect(() => {
    if (shouldTriggerVoice) {
      if (!isListening && !isStarting) {
        logger.info("🎙️ Global Voice Trigger Activated");
        startListening();
      }
      setShouldTriggerVoice(false);
    }
  }, [shouldTriggerVoice, isListening, isStarting]);

  useEffect(() => {
    setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, 100);
  }, [messages, partialTranscript, loading])

  // Check for pending voice input on mount (from floating button tap)
  useEffect(() => {
    const checkPendingVoice = async () => {
      try {
        const result = await FloatingButton.checkPendingVoiceInput();
        if (result.pending) {
          logger.info('🎙️ Pending voice input detected from floating button, auto-starting recording');
          // Small delay to ensure UI is ready
          setTimeout(() => startListening(), 500);
        }
      } catch (e) {
        // Plugin not available (web mode) - ignore
      }
    };

    if (activeConnection) {
      checkPendingVoice();
    }
  }, [activeConnection]);

  // Conversation Mode: Auto-listen after TTS finishes
  useEffect(() => {
    const handleAutoListen = () => {
      if (!isListening && !loading) {
        logger.info('🎙️ Auto-listen triggered by conversation mode');
        startListening();
      }
    };

    window.addEventListener('butler-auto-listen', handleAutoListen);
    return () => window.removeEventListener('butler-auto-listen', handleAutoListen);
  }, [isListening, loading, startListening]);

  // Load History
  useEffect(() => {
    if (!activeConnection) return;
    const loadHistory = async () => {
      const { data } = await supabase.from('chat_history').select('*').eq('connection_id', activeConnection.id).order('created_at', { ascending: false }).limit(50);
      if (data) {
        // Map DB format (ai_response as JSON) to UI format (ai_response as string)
        const mapped = data.reverse().map((d: any) => {
          let aiText = "";
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
            language: d.metadata?.language || 'en',
            actions_taken: d.actions_taken || [],
            created_at: d.created_at
          };
        });
        setMessages(mapped as any);
      }
    };
    loadHistory();
  }, [activeConnection, setMessages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    import('../utils/logger').then(({ logger }) => logger.info("👉 Manual Submit Clicked", { text: inputText }));
    sendMessage(inputText);
    setInputText('');
  };

  const handleDownloadLogs = () => {
    import('../utils/logger').then(({ logger }) => {
      logger.downloadLogs();
    });
  };

  const handleToggleTodo = async (listEntityId: string, itemSummary: string) => {
    const key = `${listEntityId}_${itemSummary}`;
    const nextState = !completedTodos[key];
    setCompletedTodos(prev => ({ ...prev, [key]: nextState }));

    const apiUrl = (activeConnection as any)?.api_url;
    const apiToken = (activeConnection as any)?.token || (activeConnection as any)?.api_token;
    if (apiUrl && apiToken) {
      try {
        await manageHATodoItem(apiUrl, apiToken, 'update', {
          listEntityId: listEntityId || 'todo.shopping_list',
          item: itemSummary,
          status: nextState ? 'completed' : 'needs_action'
        });
      } catch (err: any) {
        logger.error('Failed to update todo item:', err);
      }
    }
  };

  const handleActivateAutomation = async (autoData: any) => {
    const apiUrl = (activeConnection as any)?.api_url;
    const apiToken = (activeConnection as any)?.token || (activeConnection as any)?.api_token;
    if (apiUrl && apiToken) {
      try {
        await saveHAAutomation(apiUrl, apiToken, autoData);
        setActivatedAutomations(prev => ({ ...prev, [autoData.id]: true }));
      } catch (err: any) {
        alert(`Activeren mislukt: ${err.message}`);
      }
    } else {
      alert('Geen actieve Home Assistant verbinding met token.');
    }
  };

  const handleCopyYaml = (autoData: any) => {
    const yamlString = `alias: "${autoData.alias}"
description: "${autoData.description || ''}"
trigger:
${JSON.stringify(autoData.trigger, null, 2)}
condition:
${JSON.stringify(autoData.condition || [], null, 2)}
action:
${JSON.stringify(autoData.action, null, 2)}
mode: ${autoData.mode || 'single'}`;

    navigator.clipboard.writeText(yamlString);
    setCopiedYaml(autoData.id);
    setTimeout(() => setCopiedYaml(null), 3000);
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

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
                      {actions?.map((a: any, i: number) => {
                        // A. Weather Widget Card
                        if (a.type === 'weather' && a.data?.current) {
                          return (
                            <div key={i} className="chat-widget-card weather-widget">
                              <div className="weather-header">
                                <div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    {a.data.location?.name || 'Huidige Locatie'}
                                  </div>
                                  <div className="weather-temp">{a.data.current.temperature_c}°C</div>
                                </div>
                                <div style={{ fontSize: '2rem' }}>
                                  {a.data.current.is_day ? '☀️' : '🌙'}
                                </div>
                              </div>
                              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {a.data.current.condition_nl}
                              </div>
                              <div className="weather-badges">
                                <span className="weather-chip">💨 {a.data.current.wind_speed_kmh} km/h (stoten {a.data.current.wind_gusts_kmh} km/h)</span>
                                <span className="weather-chip">💧 Dauwpunt {a.data.current.dew_point_c}°C</span>
                                <span className="weather-chip">💦 Vocht {a.data.current.relative_humidity}%</span>
                                {a.data.current.precipitation_mm > 0 && (
                                  <span className="weather-chip" style={{ color: '#60a5fa' }}>🌧️ {a.data.current.precipitation_mm} mm</span>
                                )}
                              </div>
                            </div>
                          );
                        }

                        // B. Energy Spot Price Widget Card
                        if (a.type === 'energy' && a.data?.today_summary) {
                          return (
                            <div key={i} className="chat-widget-card energy-widget">
                              <div className="energy-summary-row">
                                <div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                    Stroomprijs ({a.data.provider || 'EPEX Spot'})
                                  </div>
                                  <div className="energy-current-price">
                                    {a.data.current_price !== undefined ? a.data.current_price.toFixed(3) : '–'} {a.data.unit || '€/kWh'}
                                  </div>
                                </div>
                                {a.data.cheapest_slot_today && (
                                  <div className="energy-cheapest-pill">
                                    🏷️ Goedkoopst: {a.data.cheapest_slot_today.time} ({a.data.cheapest_slot_today.price?.toFixed(3)} {a.data.unit})
                                  </div>
                                )}
                              </div>

                              {Array.isArray(a.data.hourly_curve_today) && a.data.hourly_curve_today.length > 0 && (
                                <div>
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                    24-uurs prijscurve vandaag
                                  </div>
                                  <div className="energy-bars-container">
                                    {(() => {
                                      const prices = a.data.hourly_curve_today.map((h: any) => h.price);
                                      const minP = Math.min(...prices);
                                      const maxP = Math.max(...prices);
                                      const range = Math.max(0.01, maxP - minP);
                                      const currentHour = new Date().getHours();

                                      return a.data.hourly_curve_today.map((h: any, idx: number) => {
                                        const normalized = Math.max(0.15, (h.price - minP) / range);
                                        const heightPercent = Math.round(normalized * 100);
                                        const isCurrent = idx === currentHour;
                                        const isCheapest = h.time === a.data.cheapest_slot_today?.time;
                                        const bg = isCheapest ? '#10b981' : isCurrent ? '#6366f1' : h.price > a.data.today_summary.average ? '#ef4444' : '#3b82f6';

                                        return (
                                          <div key={idx} className="energy-bar-col" title={`${h.time}: ${h.price.toFixed(3)} ${a.data.unit}`}>
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
                        if (a.type === 'todo' && a.data) {
                          return (
                            <div key={i} className="chat-widget-card todo-widget">
                              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#a5b4fc', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span>📋</span>
                                <span>{a.entity_id || 'Boodschappen- & Takenlijst'}</span>
                              </div>
                              {Array.isArray(a.data.pending_items) && a.data.pending_items.length > 0 ? (
                                a.data.pending_items.map((item: any, idx: number) => {
                                  const itemText = typeof item === 'string' ? item : item.summary;
                                  const isDone = completedTodos[`${a.entity_id}_${itemText}`];
                                  return (
                                    <div key={idx} className="todo-row" onClick={() => handleToggleTodo(a.entity_id, itemText)}>
                                      <div className={`todo-checkbox-box ${isDone ? 'checked' : ''}`}>
                                        {isDone ? '✓' : ''}
                                      </div>
                                      <span className={`todo-text ${isDone ? 'checked' : ''}`}>{itemText}</span>
                                    </div>
                                  );
                                })
                              ) : a.data.item ? (
                                <div className="todo-row" onClick={() => handleToggleTodo(a.entity_id, a.data.item)}>
                                  <div className={`todo-checkbox-box ${completedTodos[`${a.entity_id}_${a.data.item}`] ? 'checked' : ''}`}>
                                    {completedTodos[`${a.entity_id}_${a.data.item}`] ? '✓' : ''}
                                  </div>
                                  <span className={`todo-text ${completedTodos[`${a.entity_id}_${a.data.item}`] ? 'checked' : ''}`}>{a.data.item}</span>
                                </div>
                              ) : null}
                            </div>
                          );
                        }

                        // E. Calendar Widget
                        if (a.type === 'calendar' && Array.isArray(a.data?.events) && a.data.events.length > 0) {
                          return (
                            <div key={i} className="chat-widget-card" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span>📅</span>
                                <span>Afspraken & Kalender ({a.entity_id})</span>
                              </div>
                              {a.data.events.slice(0, 5).map((ev: any, idx: number) => (
                                <div key={idx} style={{ padding: '6px 8px', background: 'rgba(255,255,255,0.04)', borderRadius: '8px', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{ev.summary}</span>
                                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                    {new Date(ev.start).toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short' })}
                                  </span>
                                </div>
                              ))}
                            </div>
                          );
                        }

                        // F. Automation Preview Card Widget
                        if (a.type === 'automation' && a.data) {
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
                                  {expandedYaml[a.data.id] ? 'Verberg YAML' : 'Bekijk YAML'}
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
                                  disabled={activatedAutomations[a.data.id]}>
                                  {activatedAutomations[a.data.id] ? '✅ Geactiveerd in HA!' : '⚡ Activeer in Home Assistant'}
                                </button>
                                <button className="btn-copy-yaml" onClick={() => handleCopyYaml(a.data)}>
                                  {copiedYaml === a.data.id ? '✓ Gekopieerd' : '📋 YAML'}
                                </button>
                              </div>
                            </div>
                          );
                        }

                        // G. Fallback for device actions / generic actions
                        return (
                          <div key={i} className="action-badge" style={{ alignSelf: 'flex-start' }}>
                            ✅ {a.service} {a.entity_id}
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
