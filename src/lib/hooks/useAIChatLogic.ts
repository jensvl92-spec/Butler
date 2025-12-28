/// <reference types="vite/client" />
import { useState } from 'react';
import { useApp } from '../AppContext';
import { ChatMessage, LLMResponse } from '../../types';
// @ts-ignore
import { logger } from '../../utils/logger';

const SUPABASE_URL = (import.meta as any).env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export function useAIChatLogic() {
    const { activeConnection, entityStates, haWebSocket, addChatMessage, uiState, activeSuggestion } = useApp();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loading, setLoading] = useState(false);

    // Local Execution Helper
    const executeActionsClientSide = async (actions: any[]) => {
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
                } else {
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
                } catch (wsErr: any) {
                    logger.error("WS Send Failed", wsErr);
                }
            } else {
                logger.warn("⚠️ Action missing entity_id, skipping:", action);
            }
        }

        // Refresh State after all actions
    };

    const sendMessage = async (text: string) => {
        if (!activeConnection || !text.trim()) return;
        setLoading(true);
        // 0. Optimistic Update (Show user message immediately)
        const tempId = Date.now().toString();

        try {
            logger.info("Sending message", { text, connectionId: activeConnection.id });

            const optimisticMsg: ChatMessage = {
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
            const devices = Object.values(entityStates).map((s: any) => ({
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

            let aiData: LLMResponse = {} as LLMResponse;

            // DYNAMIC DISCOVERY: Try to find the true local IP via HA Config
            // This bypasses NAT Loopback issues with DuckDNS URLs
            let butlerApiUrl = 'http://homeassistant.local:8000/process'; // Default fallback

            try {
                // 1. Try to get Internal URL from HA Config (if we haven't cached it?)
                // For now, we fetch it every time or reliable fast fetch.
                // Or better: use the one derived from activeConnection if it IS local, otherwise fetch.

                const isLocalConnection = activeConnection.api_url.includes('192.168') || activeConnection.api_url.includes('.local');

                if (isLocalConnection) {
                    // If we are already connected via IP, just use that hostname
                    const haUrl = new URL(activeConnection.api_url);
                    butlerApiUrl = `http://${haUrl.hostname}:8000/process`;
                } else {
                    // We are on external connection (DuckDNS), try to find internal IP
                    try {
                        const configRes = await fetch(`${activeConnection.api_url}/api/config`, {
                            headers: { 'Authorization': `Bearer ${activeConnection.api_token}` }
                        });
                        if (configRes.ok) {
                            const configData = await configRes.json();
                            if (configData.internal_url) {
                                const internalUrl = new URL(configData.internal_url);
                                butlerApiUrl = `http://${internalUrl.hostname}:8000/process`;
                                logger.info(`🔍 Discovered Internal HA IP: ${internalUrl.hostname}`);
                            }
                        }
                    } catch (configErr) {
                        logger.warn("Failed to fetch HA Config for Internal URL", configErr);
                    }
                }
            } catch (setupErr) {
                logger.warn("URL Discovery Error", setupErr);
            }

            logger.info(`🌐 Sending to Local Butler: ${butlerApiUrl}`);

            try {
                // Set a timeout for the fetch to avoid infinite hanging
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

                const res = await fetch(butlerApiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!res.ok) {
                    const errText = await res.text();
                    logger.error("Backend Error Response", { status: res.status, body: errText });
                    throw new Error(`Server Error ${res.status}: ${errText}`);
                }

                aiData = await res.json();
                logger.info("📥 Received AI Response", aiData);

            } catch (networkError: any) {
                logger.warn(`⚠️ Primary connection failed: ${networkError.message}. Retrying with fallbacks...`);

                // FAILOVER STRATEGY
                const fallbacks = [
                    'http://homeassistant.local:8000/process',
                    'http://homeassistant:8000/process'
                ];

                // If we tried one, don't retry it
                const uniqueFallbacks = fallbacks.filter(f => f !== butlerApiUrl);

                let success = false;
                for (const fbUrl of uniqueFallbacks) {
                    if (success) break;
                    logger.info(`🔄 Retrying with Fallback: ${fbUrl}`);
                    try {
                        const cont2 = new AbortController();
                        const tm2 = setTimeout(() => cont2.abort(), 5000); // 5s timeout

                        const res2 = await fetch(fbUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload),
                            signal: cont2.signal
                        });
                        clearTimeout(tm2);

                        if (res2.ok) {
                            aiData = await res2.json();
                            logger.info("📥 Received AI Response (Fallback)", aiData);
                            success = true;
                        }
                    } catch (e) {
                        logger.warn(`Fallback ${fbUrl} failed.`);
                    }
                }

                if (!success) {
                    // If all local fails, desperate try on External URL (if strictly forwarded)
                    // But we force HTTP, so external might fail if only HTTPS allowed.
                    throw new Error("Unable to connect to Butler Crew on any local address.");
                }
            }


            logger.info("📥 Received AI Response", aiData); // This logs full object to Debug Tile

            // Log explicitly if actions are missing (but only if NO scheduled tasks either)
            const hasScheduled = (aiData.scheduled_tasks && aiData.scheduled_tasks > 0) || (aiData.scheduled_actions && aiData.scheduled_actions.length > 0);

            if ((!aiData.actions || aiData.actions.length === 0) && !hasScheduled) {
                logger.warn("AI Response has NO ACTIONS", { text: aiData.text });
            } else if (hasScheduled) {
                logger.info(`⏳ AI Scheduled ${aiData.scheduled_tasks} tasks (No immediate actions).`);
            }

            // Ingest Backend Logs
            if (aiData.logs && aiData.logs.length > 0) {
                aiData.logs.forEach((logLine: string) => {
                    logger.info(`[SERVER] ${logLine}`);
                });
            }

            // 3. UI Update (Replace Optimistic Message)
            const completedMsg: ChatMessage = {
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

        } catch (e: any) {
            console.error("AI Error", e);
            logger.error("AI Logic Exception", { message: e.message, stack: e.stack });

            // Show error in chat
            const errorMsg: ChatMessage = {
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
        } finally {
            setLoading(false);
        }
    };

    return { messages, setMessages, sendMessage, loading };
}
