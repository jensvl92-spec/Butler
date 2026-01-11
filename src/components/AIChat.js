import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useEffect, useRef, useState } from 'react';
import { registerPlugin } from '@capacitor/core';
import { useApp } from '../lib/AppContext';
import { useAIChatLogic } from '../lib/hooks/useAIChatLogic';
import { useDeepgramVoice } from '../lib/hooks/useDeepgramVoice';
import { supabase } from '../lib/supabase';
// @ts-ignore
import { logger } from '../utils/logger';
const FloatingButton = registerPlugin('FloatingButton');
export function AIChat() {
    const { activeConnection } = useApp();
    const { messages, setMessages, sendMessage, loading, conversationMode } = useAIChatLogic();
    /* Removed duplicate hook call */
    // --- RESTORED LOGIC ---
    const [inputText, setInputText] = useState('');
    const chatEndRef = useRef(null);
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
            chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }, 100);
    }, [messages, partialTranscript, loading]);
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
            }
            catch (e) {
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
        if (!activeConnection)
            return;
        const loadHistory = async () => {
            const { data } = await supabase.from('chat_history').select('*').eq('connection_id', activeConnection.id).order('created_at', { ascending: false }).limit(50);
            if (data) {
                // Map DB format (ai_response as JSON) to UI format (ai_response as string)
                const mapped = data.reverse().map((d) => {
                    let aiText = "";
                    if (typeof d.ai_response === 'string') {
                        aiText = d.ai_response;
                    }
                    else if (d.ai_response && d.ai_response.text) {
                        aiText = d.ai_response.text;
                    }
                    else {
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
                setMessages(mapped);
            }
        };
        loadHistory();
    }, [activeConnection, setMessages]);
    const handleSubmit = (e) => {
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
    if (!activeConnection)
        return _jsx("div", { className: "chat-empty", children: "Select a connection to start chatting" });
    return (_jsxs("div", { className: "ai-chat", style: { position: 'relative' }, children: [conversationMode && (_jsx("div", { style: {
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
                }, children: "\uD83C\uDF99\uFE0F Hands-Free Mode Active" })), _jsx("div", { style: { position: 'fixed', top: '50px', right: '10px', zIndex: 9999 }, children: _jsx("button", { onClick: handleDownloadLogs, style: { padding: '8px 12px', background: '#333', color: '#fff', border: '1px solid #555', borderRadius: '4px', fontSize: '12px', opacity: 0.9, boxShadow: '0 2px 5px rgba(0,0,0,0.5)' }, children: "\uD83D\uDCDC Debug Logs" }) }), _jsxs("div", { className: "chat-messages", children: [messages.map((msg) => (_jsxs(React.Fragment, { children: [msg.user_message && (_jsx("div", { className: "message-group", children: _jsx("div", { className: "message user", children: _jsx("p", { children: msg.user_message }) }) })), _jsxs("div", { className: "message-group", children: [_jsx("div", { className: "message ai", children: msg.ai_response ? (_jsx("p", { children: (() => {
                                                // 🧹 CLEANUP HISTORY: If response is raw JSON (from old bug), unwrap it
                                                try {
                                                    if (msg.ai_response.trim().startsWith('{')) {
                                                        const parsed = JSON.parse(msg.ai_response);
                                                        return parsed.text || msg.ai_response;
                                                    }
                                                }
                                                catch (e) { }
                                                return msg.ai_response;
                                            })() })) : (_jsxs("div", { className: "typing-indicator", children: [_jsx("span", { children: "." }), _jsx("span", { children: "." }), _jsx("span", { children: "." })] })) }), (() => {
                                        let actions = msg.actions_taken;
                                        let scheduled = msg.scheduled_actions;
                                        // Try to extract from JSON if not present in structured fields
                                        if ((!actions || actions.length === 0) && msg.ai_response?.trim().startsWith('{')) {
                                            try {
                                                const parsed = JSON.parse(msg.ai_response);
                                                actions = parsed.actions || [];
                                                scheduled = parsed.scheduled_actions || [];
                                            }
                                            catch (e) { }
                                        }
                                        return (_jsxs(_Fragment, { children: [actions && actions.length > 0 && (_jsx("div", { className: "actions-taken", children: actions.map((a, i) => (_jsxs("div", { className: "action-badge", children: ["\u2705 ", a.service, " ", a.entity_id] }, i))) })), scheduled && scheduled.length > 0 && (_jsx("div", { className: "actions-taken", children: scheduled.map((a, i) => (_jsxs("div", { className: "action-badge", style: { background: '#eab308', color: '#000' }, children: ["\u23F0 ", a.title, " (", a.delay_seconds || Math.round((a.wait_ms || 0) / 1000), "s)"] }, i))) }))] }));
                                    })()] })] }, msg.id))), _jsx("div", { ref: chatEndRef })] }), isListening && partialTranscript && (_jsxs("p", { style: { color: '#aaa', fontStyle: 'italic', margin: '4px 0', textAlign: 'center' }, children: [isWhisper ? '🤫' : '👂', " ", partialTranscript, audioLevel > 0 && _jsxs("span", { style: { marginLeft: '8px', fontSize: '10px', opacity: 0.6 }, children: ["(", audioLevel, "%)"] })] })), _jsx("form", { onSubmit: handleSubmit, className: "chat-input-form", children: _jsxs("div", { className: "input-group", children: [_jsx("input", { type: "text", value: inputText, onChange: (e) => setInputText(e.target.value), placeholder: "Tap mic to speak...", disabled: false }), _jsx("button", { type: "button", className: `voice-btn ${isListening ? 'listening' : ''} ${isStarting ? 'connecting' : ''}`, onClick: () => isListening ? stopListening('user_tap') : startListening(), disabled: isStarting, style: { backgroundColor: isListening ? '#ef4444' : isStarting ? '#eab308' : undefined }, children: isListening ? '🛑' : isStarting ? '⏳' : '🎙️' }), _jsx("button", { type: "submit", disabled: loading || !inputText.trim(), children: loading ? '...' : 'Send' })] }) })] }));
}
