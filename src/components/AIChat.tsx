import React, { useEffect, useRef, useState } from 'react'
import { registerPlugin } from '@capacitor/core'
import { useApp } from '../lib/AppContext'
import { useAIChatLogic } from '../lib/hooks/useAIChatLogic'
import { useDeepgramVoice } from '../lib/hooks/useDeepgramVoice'
import { supabase } from '../lib/supabase'

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
  /* Removed duplicate hook call */
  // --- RESTORED LOGIC ---
  const [inputText, setInputText] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)


  // --- RESTORED LOGIC ---

  // Clear Logs on Mount
  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      .typing-indicator span {
        animation: blink 1.4s infinite both;
        font-size: 24px;
        line-height: 10px;
        margin: 0 1px;
      }
      .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
      .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes blink { 0% { opacity: .2; } 20% { opacity: 1; } 100% { opacity: .2; } }
    `;
    document.head.appendChild(style);

    import('../utils/logger').then(({ logger }) => logger.clearLogs());
  }, []);

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
            aiText = d.ai_response;
          } else if (d.ai_response && d.ai_response.text) {
            aiText = d.ai_response.text;
          } else {
            aiText = JSON.stringify(d.ai_response || "");
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

  if (!activeConnection) return <div className="chat-empty">Select a connection to start chatting</div>

  return (
    <div className="ai-chat" style={{ position: 'relative' }}>
      {/* Conversation Mode Indicator */}
      {conversationMode && (
        <div style={{
          position: 'fixed',
          top: '10px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999,
          background: 'linear-gradient(135deg, #10b981, #059669)',
          color: '#fff',
          padding: '8px 16px',
          borderRadius: '20px',
          fontSize: '13px',
          fontWeight: 'bold',
          boxShadow: '0 4px 15px rgba(16, 185, 129, 0.4)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          animation: 'pulse 2s infinite'
        }}>
          🎙️ Hands-Free Mode Active
        </div>
      )}

      {/* Debug Logs Button */}
      <div style={{ position: 'fixed', top: '50px', right: '10px', zIndex: 9999 }}>
        <button onClick={handleDownloadLogs} style={{ padding: '8px 12px', background: '#333', color: '#fff', border: '1px solid #555', borderRadius: '4px', fontSize: '12px', opacity: 0.9, boxShadow: '0 2px 5px rgba(0,0,0,0.5)' }}>
          📜 Debug Logs
        </button>
      </div>

      <div className="chat-messages">
        {messages.map((msg) => (
          <React.Fragment key={msg.id}>
            {/* 1. User Message Part */}
            {msg.user_message && (
              <div className="message-group">
                <div className="message user">
                  <p>{msg.user_message}</p>
                </div>
              </div>
            )}

            {/* 2. AI Response Part */}
            <div className="message-group">
              <div className="message ai">
                {msg.ai_response ? (
                  <p>
                    {(() => {
                      // 🧹 CLEANUP HISTORY: If response is raw JSON (from old bug), unwrap it
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
              </div>

              {/* Actions & Schedule Badges (Attached to AI response) */}
              {/* First check msg.actions_taken, then fallback to parsing from ai_response JSON */}
              {(() => {
                let actions = msg.actions_taken;
                let scheduled = msg.scheduled_actions;
                // Try to extract from JSON if not present in structured fields
                if ((!actions || actions.length === 0) && msg.ai_response?.trim().startsWith('{')) {
                  try {
                    const parsed = JSON.parse(msg.ai_response);
                    actions = parsed.actions || [];
                    scheduled = parsed.scheduled_actions || [];
                  } catch (e) { }
                }
                return (
                  <>
                    {actions && actions.length > 0 && (
                      <div className="actions-taken">
                        {actions.map((a: any, i: number) => (
                          <div key={i} className="action-badge">✅ {a.service} {a.entity_id}</div>
                        ))}
                      </div>
                    )}
                    {scheduled && scheduled.length > 0 && (
                      <div className="actions-taken">
                        {scheduled.map((a: any, i: number) => (
                          <div key={i} className="action-badge" style={{ background: '#eab308', color: '#000' }}>⏰ {a.title} ({a.delay_seconds || Math.round((a.wait_ms || 0) / 1000)}s)</div>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </React.Fragment>
        ))}
        <div ref={chatEndRef} />
      </div>

      {isListening && partialTranscript && (
        <p style={{ color: '#aaa', fontStyle: 'italic', margin: '4px 0', textAlign: 'center' }}>
          {isWhisper ? '🤫' : '👂'} {partialTranscript}
          {audioLevel > 0 && <span style={{ marginLeft: '8px', fontSize: '10px', opacity: 0.6 }}>({audioLevel}%)</span>}
        </p>
      )}

      <form onSubmit={handleSubmit} className="chat-input-form">
        <div className="input-group">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Tap mic to speak..."
            disabled={false}
          />
          <button
            type="button"
            className={`voice-btn ${isListening ? 'listening' : ''} ${isStarting ? 'connecting' : ''}`}
            onClick={() => isListening ? stopListening('user_tap') : startListening()}
            disabled={isStarting}
            style={{ backgroundColor: isListening ? '#ef4444' : isStarting ? '#eab308' : undefined }}
          >
            {isListening ? '🛑' : isStarting ? '⏳' : '🎙️'}
          </button>
          <button type="submit" disabled={loading || !inputText.trim()}>
            {loading ? '...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}
