import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/AppContext';
import { useAIChatLogic } from '../lib/hooks/useAIChatLogic';
import { useVoiceInput } from '../lib/hooks/useVoiceInput';
import { supabase } from '../lib/supabase';
export function AIChat() {
    const { activeConnection } = useApp();
    const { messages, setMessages, sendMessage, loading } = useAIChatLogic();
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
            chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }, 100);
    }, [messages, partialTranscript, loading]);
    // Load History
    useEffect(() => {
        if (!activeConnection)
            return;
        const loadHistory = async () => {
            const { data } = await supabase.from('chat_history').select('*').eq('connection_id', activeConnection.id).order('created_at', { ascending: false }).limit(50);
            if (data)
                setMessages(data.reverse());
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
    return (_jsxs("div", { className: "ai-chat", style: { position: 'relative' }, children: [_jsx("div", { style: { position: 'fixed', top: '50px', right: '10px', zIndex: 9999 }, children: _jsx("button", { onClick: handleDownloadLogs, style: { padding: '8px 12px', background: '#333', color: '#fff', border: '1px solid #555', borderRadius: '4px', fontSize: '12px', opacity: 0.9, boxShadow: '0 2px 5px rgba(0,0,0,0.5)' }, children: "\uD83D\uDCDC Debug Logs" }) }), _jsxs("div", { className: "chat-messages", children: [messages.map((msg) => (_jsxs(React.Fragment, { children: [msg.user_message && (_jsx("div", { className: "message-group", children: _jsx("div", { className: "message user", children: _jsx("p", { children: msg.user_message }) }) })), _jsxs("div", { className: "message-group", children: [_jsx("div", { className: "message ai", children: msg.ai_response ? (_jsx("p", { children: (() => {
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
                                    })()] })] }, msg.id))), _jsx("div", { ref: chatEndRef })] }), isListening && partialTranscript && _jsxs("p", { style: { color: '#aaa', fontStyle: 'italic', margin: '4px 0', textAlign: 'center' }, children: ["\uD83D\uDC42 ", partialTranscript] }), _jsx("form", { onSubmit: handleSubmit, className: "chat-input-form", children: _jsxs("div", { className: "input-group", children: [_jsx("input", { type: "text", value: inputText, onChange: (e) => setInputText(e.target.value), placeholder: "Tap mic to speak...", disabled: false }), _jsx("button", { type: "button", className: `voice-btn ${isListening ? 'listening' : ''}`, onClick: isListening ? stopListening : startListening, disabled: false, style: { backgroundColor: isListening ? '#ef4444' : undefined }, children: isListening ? '🛑' : '🎙️' }), _jsx("button", { type: "submit", disabled: loading || !inputText.trim(), children: loading ? '...' : 'Send' })] }) })] }));
}
