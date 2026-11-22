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

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(text.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={key++} style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '4px', fontSize: '0.88em' }}>
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIdx = match.index + token.length;
  }

  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }
  return nodes;
}

function getVisualToneStyle(tone?: string): { bg: string; border: string; text: string } {
  switch ((tone || '').toLowerCase()) {
    case 'good':
    case 'green':
    case 'success':
      return { bg: 'rgba(16, 185, 129, 0.14)', border: 'rgba(16, 185, 129, 0.35)', text: '#34d399' };
    case 'active':
    case 'info':
    case 'blue':
      return { bg: 'rgba(99, 102, 241, 0.16)', border: 'rgba(99, 102, 241, 0.38)', text: '#a5b4fc' };
    case 'warn':
    case 'warning':
    case 'amber':
      return { bg: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.35)', text: '#fbbf24' };
    case 'alert':
    case 'error':
    case 'red':
      return { bg: 'rgba(239, 68, 68, 0.14)', border: 'rgba(239, 68, 68, 0.35)', text: '#f87171' };
    default:
      return { bg: 'rgba(255, 255, 255, 0.05)', border: 'rgba(255, 255, 255, 0.12)', text: 'var(--text-primary, #f1f5f9)' };
  }
}

function parseTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());
}

function isTableSeparatorLine(line: string): boolean {
  return /^\|?[\s:-]+\|[\s|:-]*$/.test(line.trim());
}

function renderRichMessage(raw: string): React.ReactNode {
  let displayText = raw;
  try {
    if (raw.trim().startsWith('{')) {
      const parsed = JSON.parse(raw);
      if (parsed?.text) displayText = parsed.text;
    }
  } catch { }

  // Defensively strip any stray dual-channel tags if an older message had them
  displayText = displayText
    .replace(/<card>[\s\S]*?<\/card>/gi, '')
    .replace(/<\/?(?:spoken|card)\b[^>]*>/gi, '')
    .trim();

  const lines = displayText.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Detect Markdown Table (header row with | followed by separator row |---|---|)
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      const headers = parseTableCells(lines[i]);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|') && !isTableSeparatorLine(lines[i])) {
        bodyRows.push(parseTableCells(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`tbl-${i}`} style={{ overflowX: 'auto', margin: '4px 0', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ background: 'rgba(99, 102, 241, 0.12)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                {headers.map((h, hi) => (
                  <th key={hi} style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 700, color: '#c7d2fe', whiteSpace: 'nowrap' }}>
                    {renderInlineMarkdown(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri} style={{ borderBottom: ri < bodyRows.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none', background: ri % 2 === 1 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{ padding: '6px 10px', color: 'var(--text-primary, #f1f5f9)' }}>
                      {renderInlineMarkdown(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (!trimmed) {
      blocks.push(<div key={`sp-${i}`} style={{ height: '4px' }} />);
      i++;
      continue;
    }

    const headingMatch = trimmed.match(/^#{1,4}\s+(.*)$/);
    if (headingMatch) {
      blocks.push(
        <div key={`hd-${i}`} style={{ fontWeight: 700, fontSize: '0.96rem', marginTop: i > 0 ? '4px' : 0 }}>
          {renderInlineMarkdown(headingMatch[1])}
        </div>
      );
      i++;
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*•]\s+(.*)$/);
    if (bulletMatch) {
      blocks.push(
        <div key={`bl-${i}`} style={{ display: 'flex', gap: '6px', paddingLeft: '4px' }}>
          <span style={{ opacity: 0.7 }}>•</span>
          <span>{renderInlineMarkdown(bulletMatch[1])}</span>
        </div>
      );
      i++;
      continue;
    }

    blocks.push(<div key={`ln-${i}`}>{renderInlineMarkdown(lines[i])}</div>);
    i++;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', lineHeight: 1.5 }}>
      {blocks}
    </div>
  );
}

interface AIChatProps {
  disableGlobalVoiceListeners?: boolean;
}

export function AIChat({ disableGlobalVoiceListeners = false }: AIChatProps = {}) {
  const { activeConnection, uiState, shouldTriggerVoice, setShouldTriggerVoice } = useApp()
  const { messages, setMessages, sendMessage, loading, isSpeaking, stopCurrentSpeech, conversationMode } = useAIChatLogic()
  const [inputText, setInputText] = useState('')
  const [completedTodos, setCompletedTodos] = useState<Record<string, boolean>>({})
  const [activatedAutomations, setActivatedAutomations] = useState<Record<string, boolean>>({})
  const [activatingAutomations, setActivatingAutomations] = useState<Record<string, boolean>>({})
  const [copiedYaml, setCopiedYaml] = useState<string | null>(null)
  const [expandedYaml, setExpandedYaml] = useState<Record<string, boolean>>({})
  const chatEndRef = useRef<HTMLDivElement>(null)

  const { isListening, isStarting, isFinalizing, partialTranscript, startListening, stopListening, error: voiceError, isWhisper } = useDeepgramVoice({
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
                  renderRichMessage(msg.ai_response)
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

                        // G0. Glanceable Visual Summary Card (KPI highlights, key-value rows, compact tables)
                        if (a.type === 'visual_card' && a.data) {
                          const card = a.data;
                          const highlights = Array.isArray(card.highlights) ? card.highlights : [];
                          const rows = Array.isArray(card.rows) ? card.rows : [];
                          const columns = Array.isArray(card.columns) ? card.columns : [];
                          const tableRows = Array.isArray(card.table) ? card.table : [];

                          return (
                            <div
                              key={i}
                              className="chat-widget-card"
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '10px',
                                padding: '12px 14px',
                                borderRadius: '14px',
                                background: 'linear-gradient(145deg, rgba(30, 41, 59, 0.72), rgba(15, 23, 42, 0.85))',
                                border: '1px solid rgba(148, 163, 184, 0.18)',
                                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.22)'
                              }}
                            >
                              {/* Card Header */}
                              {(card.title || card.subtitle) && (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                                    {card.icon && <span style={{ fontSize: '1.15rem', lineHeight: 1 }}>{card.icon}</span>}
                                    <div style={{ minWidth: 0 }}>
                                      {card.title && (
                                        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#f8fafc', letterSpacing: '-0.01em' }}>
                                          {card.title}
                                        </div>
                                      )}
                                      {card.subtitle && (
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary, #94a3b8)', marginTop: '1px' }}>
                                          {card.subtitle}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* KPI Highlights Grid — instant 1-glance comprehension */}
                              {highlights.length > 0 && (
                                <div style={{
                                  display: 'grid',
                                  gridTemplateColumns: highlights.length === 1 ? '1fr' : 'repeat(auto-fit, minmax(115px, 1fr))',
                                  gap: '8px'
                                }}>
                                  {highlights.map((h: any, hi: number) => {
                                    const tone = getVisualToneStyle(h.tone);
                                    return (
                                      <div
                                        key={hi}
                                        style={{
                                          padding: '9px 11px',
                                          borderRadius: '11px',
                                          background: tone.bg,
                                          border: `1px solid ${tone.border}`,
                                          display: 'flex',
                                          flexDirection: 'column',
                                          gap: '2px'
                                        }}
                                      >
                                        <span style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary, #94a3b8)', fontWeight: 600 }}>
                                          {h.label}
                                        </span>
                                        <span style={{ fontSize: '1.15rem', fontWeight: 800, color: tone.text, lineHeight: 1.2 }}>
                                          {h.value}{h.unit ? ` ${h.unit}` : ''}
                                        </span>
                                        {h.sub && (
                                          <span style={{ fontSize: '0.72rem', color: 'rgba(226, 232, 240, 0.78)' }}>
                                            {h.sub}
                                          </span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}

                              {/* Key-Value Rows */}
                              {rows.length > 0 && (
                                <div style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  borderRadius: '10px',
                                  background: 'rgba(255, 255, 255, 0.03)',
                                  border: '1px solid rgba(255, 255, 255, 0.07)',
                                  overflow: 'hidden'
                                }}>
                                  {rows.map((r: any, ri: number) => {
                                    const badgeTone = r.badge ? getVisualToneStyle(r.tone) : null;
                                    return (
                                      <div
                                        key={ri}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'space-between',
                                          gap: '10px',
                                          padding: '7px 10px',
                                          borderBottom: ri < rows.length - 1 ? '1px solid rgba(255, 255, 255, 0.06)' : 'none',
                                          fontSize: '0.82rem'
                                        }}
                                      >
                                        <span style={{ color: 'var(--text-secondary, #cbd5e1)' }}>{r.label}</span>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', textAlign: 'right' }}>
                                          <span style={{ fontWeight: 700, color: '#f8fafc' }}>{r.value}</span>
                                          {r.badge && badgeTone && (
                                            <span style={{
                                              fontSize: '0.68rem',
                                              fontWeight: 700,
                                              padding: '2px 7px',
                                              borderRadius: '999px',
                                              background: badgeTone.bg,
                                              color: badgeTone.text,
                                              border: `1px solid ${badgeTone.border}`
                                            }}>
                                              {r.badge}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}

                              {/* Compact Scannable Table */}
                              {tableRows.length > 0 && (
                                <div style={{ overflowX: 'auto', borderRadius: '10px', border: '1px solid rgba(255, 255, 255, 0.09)', background: 'rgba(255, 255, 255, 0.02)' }}>
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                                    {columns.length > 0 && (
                                      <thead>
                                        <tr style={{ background: 'rgba(99, 102, 241, 0.12)', borderBottom: '1px solid rgba(255, 255, 255, 0.09)' }}>
                                          {columns.map((col: string, ci: number) => (
                                            <th key={ci} style={{ textAlign: ci === columns.length - 1 ? 'right' : 'left', padding: '6px 9px', fontWeight: 700, color: '#c7d2fe', whiteSpace: 'nowrap' }}>
                                              {col}
                                            </th>
                                          ))}
                                        </tr>
                                      </thead>
                                    )}
                                    <tbody>
                                      {tableRows.map((tr: any[], ri: number) => (
                                        <tr key={ri} style={{ borderBottom: ri < tableRows.length - 1 ? '1px solid rgba(255, 255, 255, 0.05)' : 'none', background: ri % 2 === 1 ? 'rgba(255, 255, 255, 0.02)' : 'transparent' }}>
                                          {(Array.isArray(tr) ? tr : []).map((cell: any, ci: number) => (
                                            <td key={ci} style={{ textAlign: ci === tr.length - 1 ? 'right' : 'left', padding: '6px 9px', color: ci === 0 ? '#e2e8f0' : '#f8fafc', fontWeight: ci === tr.length - 1 ? 600 : 400 }}>
                                              {String(cell ?? '')}
                                            </td>
                                          ))}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}

                              {/* Footer Tip */}
                              {card.footer && (
                                <div style={{ fontSize: '0.73rem', color: 'var(--text-secondary, #94a3b8)', borderTop: '1px solid rgba(255, 255, 255, 0.07)', paddingTop: '6px' }}>
                                  💡 {card.footer}
                                </div>
                              )}
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

      {/* Speaking Indicator with quick mute */}
      {isSpeaking && !isListening && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '5px 12px', background: 'rgba(99, 102, 241, 0.12)', border: '1px solid rgba(99, 102, 241, 0.28)', borderRadius: '12px', margin: '4px 12px' }}>
          <span style={{ fontSize: '0.78rem', color: '#a5b4fc', fontWeight: 600 }}>🔊 Butler spreekt...</span>
          <button
            type="button"
            onClick={() => stopCurrentSpeech()}
            style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: '#e2e8f0', borderRadius: '8px', padding: '2px 8px', fontSize: '0.74rem', cursor: 'pointer', fontWeight: 600 }}
          >
            🔇 Stop
          </button>
        </div>
      )}

      {/* Voice Transcript & Listening Waveform Indicator */}
      {isListening && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '6px 0', background: isFinalizing ? 'rgba(99, 102, 241, 0.12)' : 'rgba(239, 68, 68, 0.08)', borderRadius: '12px', margin: '4px 12px' }}>
          <div className="waveform-bars">
            <div className="waveform-bar" style={{ background: isFinalizing ? '#818cf8' : '#ef4444' }} />
            <div className="waveform-bar" style={{ background: isFinalizing ? '#818cf8' : '#ef4444' }} />
            <div className="waveform-bar" style={{ background: isFinalizing ? '#818cf8' : '#ef4444' }} />
            <div className="waveform-bar" style={{ background: isFinalizing ? '#818cf8' : '#ef4444' }} />
            <div className="waveform-bar" style={{ background: isFinalizing ? '#818cf8' : '#ef4444' }} />
          </div>
          <span style={{ fontSize: '0.8rem', color: isFinalizing ? '#a5b4fc' : '#ef4444', fontWeight: 600 }}>
            {partialTranscript
              ? `${isWhisper ? '🤫 ' : ''}${partialTranscript}${isFinalizing ? ' …' : ''}`
              : isFinalizing ? 'Even verwerken...' : 'Butler luistert...'}
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
            onClick={() => {
              stopCurrentSpeech();
              if (isListening) {
                stopListening('user_tap');
              } else {
                startListening();
              }
            }}
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
