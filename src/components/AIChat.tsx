import React, { useEffect, useRef, useState } from 'react'
import { useApp } from '../lib/AppContext'
import { useAIChatLogic } from '../lib/hooks/useAIChatLogic'
import { useVoiceInput } from '../lib/hooks/useVoiceInput'
import { supabase } from '../lib/supabase'

export function AIChat() {
  const { activeConnection } = useApp()
  const { messages, setMessages, sendMessage, loading } = useAIChatLogic()
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

  // Voice Hook
  const { isListening, partialTranscript, startListening, stopListening } = useVoiceInput({
    onTranscript: (text) => setInputText(text),
    onFinalTranscript: (text) => {
      setInputText(text);
      sendMessage(text);
      setInputText(''); // Clear input after AutoSend
    }
  });

  useEffect(() => {
    setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, 100);
  }, [messages, partialTranscript, loading])

  // Load History
  useEffect(() => {
    if (!activeConnection) return;
    const loadHistory = async () => {
      const { data } = await supabase.from('chat_history').select('*').eq('connection_id', activeConnection.id).order('created_at', { ascending: false }).limit(50);
      if (data) setMessages(data.reverse() as any);
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

      {isListening && partialTranscript && <p style={{ color: '#aaa', fontStyle: 'italic', margin: '4px 0', textAlign: 'center' }}>👂 {partialTranscript}</p>}

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
            className={`voice-btn ${isListening ? 'listening' : ''}`}
            onClick={isListening ? stopListening : startListening}
            disabled={false}
            style={{ backgroundColor: isListening ? '#ef4444' : undefined }}
          >
            {isListening ? '🛑' : '🎙️'}
          </button>
          <button type="submit" disabled={loading || !inputText.trim()}>
            {loading ? '...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}
