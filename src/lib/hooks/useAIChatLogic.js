/// <reference types="vite/client" />
import { useState } from 'react';
import { useApp } from '../AppContext';
// @ts-ignore
import { logger } from '../../utils/logger';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export function useAIChatLogic() {
    const { activeConnection, entityStates, haWebSocket, addChatMessage, uiState, activeSuggestion } = useApp();
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(false);
    // Local Execution Helper
    const executeActionsClientSide = async (actions) => {
        if (!haWebSocket) {
            logger.error("❌ ExecuteActions: No/Closed WebSocket!");
            return;
        }
        logger.info("🚀 executeActionsClientSide Starting...", { count: actions.length });
        for (const action of actions) {
            logger.info("👉 Processing Action:", action);
            // Handle Client-Side Delay
            if (action.service === 'delay' || action.type === 'delay') {
                const sec = action.data?.seconds || action.data?.delay || 0;
                logger.info(`⏳ Waiting ${sec}s...`);
                await new Promise(r => setTimeout(r, sec * 1000));
                continue;
            }
            // Standard Service Call
            if (action.entity_id) {
                // Determine domain and service name
                // FIX: Handle Array entity_ids (e.g. multiple devices)
                const firstEntity = Array.isArray(action.entity_id) ? action.entity_id[0] : action.entity_id;
                let domain = firstEntity.split('.')[0];
                let service = action.service;
                // If service contains a dot (e.g. "light.turn_on"), split it
                if (service.includes('.')) {
                    const parts = service.split('.');
                    if (parts.length === 2) {
                        domain = parts[0].toLowerCase();
                        service = parts[1].toLowerCase();
                    }
                }
                else {
                    domain = domain.toLowerCase();
                    service = (service || "").toLowerCase();
                }
                const serviceData = { ...action.data, entity_id: action.entity_id };
                logger.info(`📡 Sending WS Message: ${domain}.${service}`, serviceData);
                try {
                    await haWebSocket.sendMessage({
                        type: 'call_service',
                        domain: domain,
                        service: service,
                        service_data: serviceData
                    });
                    logger.info(`✅ WS Message Sent`);
                }
                catch (wsErr) {
                    logger.error("WS Send Failed", wsErr);
                }
            }
            else {
                logger.warn("⚠️ Action missing entity_id, skipping:", action);
            }
        }
        // Refresh State after all actions
    };
    const sendMessage = async (text) => {
        if (!activeConnection || !text.trim())
            return;
        setLoading(true);
        // 0. Optimistic Update (Show user message immediately)
        const tempId = Date.now().toString();
        try {
            logger.info("Sending message", { text, connectionId: activeConnection.id });
            const optimisticMsg = {
                id: tempId,
                connection_id: activeConnection.id,
                user_message: text,
                ai_response: '', // Empty means loading
                language: 'en', // Default, updated later
                actions_taken: [],
                created_at: new Date().toISOString()
            };
            setMessages(prev => [...prev, optimisticMsg]);
            // 1. Gather Context
            const devices = Object.values(entityStates).map((s) => ({
                entity_id: s.entity_id, ...s
            })).filter(d => d.entity_id);
            // 2. Send to Backend
            logger.info("Posting to process-ai-command", { deviceCount: devices.length });
            // LOG PAYLOAD FOR DEBUGGING
            const payload = {
                connection_id: activeConnection.id,
                user_message: text,
                language: uiState.language || 'en',
                devices: devices,
                services: {},
                rooms: [],
                execute_server_side: false,
                active_suggestion: activeSuggestion,
                client_timestamp: new Date().toISOString()
            };
            logger.info("📤 Payload Preview:", JSON.stringify(payload).substring(0, 500) + "...");
            let aiData = {};
            if (!haWebSocket) {
                // If WS is down, show error immediately
                throw new Error("WebSocket disconnected. Connection to Home Assistant lost.");
            }
            // EVENT-BASED ARCHITECTURE: Fire Event -> Wait for Response Event
            // This works Local AND Remote via Home Assistant Event Bus
            // No opened ports required on user router!
            const responsePromise = new Promise((resolve, reject) => {
                // Subscribe to response event
                // Note: subscribeEvents typically returns an unsubscribe function.
                const cleanup = haWebSocket.subscribeEvents('butler_service_response', (evt) => {
                    const data = evt.event_data;
                    // Check if response matches our connection ID
                    if (data && data.connection_id === activeConnection.id) {
                        logger.info("📩 Received Event Response", data);
                        resolve(data.response);
                        // TODO: Call cleanup() if available (depends on library version)
                    }
                });
                // Timeout 45s (Generative AI is slow)
                setTimeout(() => {
                    reject(new Error("Timeout waiting for Butler Response (Event Bus). Is the Add-on running?"));
                }, 45000);
            });
            // Fire Request
            logger.info("🔥 Firing 'butler_service_request' event via WebSocket...");
            await haWebSocket.sendMessage({
                type: 'fire_event',
                event_type: 'butler_service_request',
                event_data: payload
            });
            try {
                aiData = await responsePromise;
                logger.info("✅ Event Response Processed", aiData);
            }
            catch (err) {
                logger.error("Event Bus Error", err);
                throw err;
            }
            logger.info("📥 Received AI Response", aiData); // This logs full object to Debug Tile
            // Log explicitly if actions are missing (but only if NO scheduled tasks either)
            const hasScheduled = (aiData.scheduled_tasks && aiData.scheduled_tasks > 0) || (aiData.scheduled_actions && aiData.scheduled_actions.length > 0);
            if ((!aiData.actions || aiData.actions.length === 0) && !hasScheduled) {
                logger.warn("AI Response has NO ACTIONS", { text: aiData.text });
            }
            else if (hasScheduled) {
                logger.info(`⏳ AI Scheduled ${aiData.scheduled_tasks} tasks (No immediate actions).`);
            }
            // Ingest Backend Logs
            if (aiData.logs && aiData.logs.length > 0) {
                aiData.logs.forEach((logLine) => {
                    logger.info(`[SERVER] ${logLine}`);
                });
            }
            // 3. UI Update (Replace Optimistic Message)
            const completedMsg = {
                ...optimisticMsg,
                ai_response: aiData.text,
                language: aiData.language,
                actions_taken: aiData.actions || [],
                scheduled_actions: aiData.scheduled_actions || []
            };
            setMessages(prev => prev.map(m => m.id === tempId ? completedMsg : m));
            addChatMessage(completedMsg);
            // 4. TTS
            if (aiData.text && 'speechSynthesis' in window) {
                const utter = new SpeechSynthesisUtterance(aiData.text);
                utter.lang = aiData.language === 'nl' ? 'nl-NL' : 'en-US';
                window.speechSynthesis.speak(utter);
            }
            // 5. Execute - DISABLED (Backend executes actions now via MCP)
            /*
            if (aiData.actions && aiData.actions.length > 0) {
                logger.info("Executing client-side actions", { count: aiData.actions.length, actions: aiData.actions });
                await executeActionsClientSide(aiData.actions);
            }
            */
        }
        catch (e) {
            console.error("AI Error", e);
            logger.error("AI Logic Exception", { message: e.message, stack: e.stack });
            // Show error in chat
            const errorMsg = {
                id: Date.now().toString(),
                connection_id: activeConnection.id,
                user_message: '',
                ai_response: `⚠️ Error: ${e.message || 'Network failure'}`,
                language: 'en',
                actions_taken: [],
                created_at: new Date().toISOString()
            };
            setMessages(prev => prev.map(m => m.id === tempId ? errorMsg : m));
            addChatMessage(errorMsg);
        }
        finally {
            setLoading(false);
        }
    };
    return { messages, setMessages, sendMessage, loading };
}
