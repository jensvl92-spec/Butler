/// <reference types="vite/client" />
import { useState } from 'react';
import { useApp } from '../AppContext';
import { ChatMessage, LLMResponse } from '../../types';
// @ts-ignore
import { logger } from '../../utils/logger';
import { Geolocation } from '@capacitor/geolocation';
import { Browser } from '@capacitor/browser';
import { findContactByName } from '../../utils/contactsService';
// @ts-ignore
import { TextToSpeech } from '@capacitor-community/text-to-speech';

const SUPABASE_URL = (import.meta as any).env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// Global callback for graph creation (set by App.tsx)
export let onGraphCreate: ((config: any) => void) | null = null;
export const setGraphCreateCallback = (cb: (config: any) => void) => { onGraphCreate = cb; };

export function useAIChatLogic() {
    const { activeConnection, entityStates, haWebSocket, addChatMessage, uiState, activeSuggestion } = useApp();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loading, setLoading] = useState(false);
    const [conversationMode, setConversationMode] = useState(false); // Hands-free mode for recipes

    // Local Execution Helper
    const executeActionsClientSide = async (actions: any[], originalText?: string): Promise<{ retryTriggered: boolean }> => {
        if (!haWebSocket) {
            logger.error("❌ ExecuteActions: No/Closed WebSocket!");
            return { retryTriggered: false };
        }

        logger.info("🚀 executeActionsClientSide Starting...", { count: actions.length });

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            logger.info("👉 Processing Action:", action);

            // RECIPE TIMER HANDLER (recognize multiple service names)
            if (action.service === 'recipe.timer' || action.service === 'timer.start' || action.service === 'timer.set') {
                const minutes = action.data?.minutes || (action.data?.duration ? action.data.duration / 60 : 5);
                const label = action.data?.label || action.data?.message || 'Timer';
                const seconds = action.data?.duration || minutes * 60;

                logger.info(`⏰ Setting Timer: ${label} for ${minutes} mins (${seconds}s)`);

                // Use native Capacitor plugin for reliable timer setting
                try {
                    const { registerPlugin } = await import('@capacitor/core');
                    const TimerPlugin = registerPlugin<{ setTimer: (opts: { seconds: number; message: string }) => Promise<void> }>('TimerPlugin');
                    await TimerPlugin.setTimer({ seconds, message: label });
                    logger.info("✅ Timer Set via Native Plugin");
                } catch (e: any) {
                    logger.error("❌ Failed to set timer via plugin", e);
                }
                continue;
            }

            // ALARM HANDLER (recognize multiple service names and formats)
            if (action.service === 'alarm.set' || action.service === 'alarm.start' || action.type === 'set_alarm') {
                let hour = action.data?.hour;
                let minute = action.data?.minute || 0;
                const message = action.data?.message || action.data?.label || 'Alarm';
                const days = action.data?.days;

                // If duration is provided instead of hour/minute, calculate from current time
                if (typeof hour !== 'number' && action.data?.duration) {
                    const durationSeconds = action.data.duration;
                    const now = new Date();
                    const targetTime = new Date(now.getTime() + durationSeconds * 1000);
                    hour = targetTime.getHours();
                    minute = targetTime.getMinutes();
                    logger.info(`⏰ Calculated alarm time from duration: ${hour}:${minute.toString().padStart(2, '0')}`);
                }

                if (typeof hour !== 'number') {
                    logger.error("❌ Alarm missing required 'hour' parameter", action);
                    continue;
                }

                logger.info(`⏰ Setting Alarm: ${hour}:${minute.toString().padStart(2, '0')} - ${message}`);

                try {
                    const { registerPlugin } = await import('@capacitor/core');
                    const TimerPlugin = registerPlugin<{ setAlarm: (opts: { hour: number; minute: number; message: string; days?: number[] }) => Promise<void> }>('TimerPlugin');
                    await TimerPlugin.setAlarm({ hour, minute, message, days });
                    logger.info("✅ Alarm Set via Native Plugin");
                } catch (e: any) {
                    logger.error("❌ Failed to set alarm via plugin", e);
                }
                continue;
            }

            const hasInlineDelay = (action.data?.delay && action.data.delay > 0) || (action.delay && action.delay > 0);

            // GHOST RUNNER: Intercept Delays
            if (action.service === 'delay' || action.type === 'delay' || hasInlineDelay) {
                const sec = action.data?.seconds || action.data?.delay || action.delay || 0;

                // Determine target action: Inline uses current, Standalone uses next
                const isInline = hasInlineDelay;
                const targetAction = isInline ? action : actions[i + 1];

                if (targetAction && targetAction.entity_id && targetAction.service) {
                    logger.info(`👻 Offloading to Ghost Runner: Wait ${sec}s then call ${targetAction.service} on ${targetAction.entity_id}`);

                    // Format seconds to HH:MM:SS for the script delay
                    const date = new Date(0);
                    date.setSeconds(sec);
                    const timeString = date.toISOString().substring(11, 19);

                    // Call the ghost script
                    try {
                        await haWebSocket.sendMessage({
                            type: 'call_service',
                            domain: 'script',
                            service: 'turn_on',
                            service_data: {
                                entity_id: 'script.ai_ghost_runner',
                                variables: {
                                    delay: timeString,
                                    service: targetAction.service,
                                    entity: Array.isArray(targetAction.entity_id) ? targetAction.entity_id[0] : targetAction.entity_id
                                }
                            }
                        });
                        logger.info("✅ Ghost Runner Deployed");

                        // If inline, we consumed THIS action, so continue.
                        // If standalone, we consumed NEXT action, so skip i+1.
                        if (!isInline) i++;
                        continue;
                    } catch (wsErr: any) {
                        logger.error("Ghost Runner Deployment Failed", wsErr);
                        // Fallback? Maybe just continue to standard execution
                    }
                } else {
                    // No next action to delay? Just wait locally (fallback)
                    logger.info(`⏳ Standalone Delay: Waiting ${sec}s...`);
                    await new Promise(r => setTimeout(r, sec * 1000));
                    continue;
                }
            }

            // GRAPH.CREATE: Create visualization
            if (action.service === 'graph.create') {
                logger.info("📊 Graph Create Action:", action.data);
                if (onGraphCreate && action.data) {
                    onGraphCreate(action.data);
                    logger.info("✅ Graph creation triggered");
                } else {
                    logger.warn("⚠️ Graph callback not set or missing data");
                }
                continue;
            }

            // CREATE_EVENT: Server-side executed, just acknowledge
            if (action.action === 'create_event' || action.service === 'calendar.create_event') {
                logger.info("📅 Calendar event handled server-side", action.parameters || action.data);
                continue;
            }

            // GPS REQUEST (Priority Intercept)
            // Handle both action-style (PA) and service-style (Butler) requests
            if (action.service === 'request_gps' || action.action === 'request_gps' || action.type === 'request_gps') {
                if (!originalText) {
                    logger.warn("⚠️ Received request_gps but no original text found to retry.");
                    continue;
                }
                logger.info("📡 Server requested GPS fallback. Fetching...");
                try {
                    setLoading(true);
                    const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
                    const loc = { lat: position.coords.latitude, lon: position.coords.longitude };
                    logger.info("📍 Fallback GPS Acquired. Retrying...", loc);

                    // Retry with forced location - return flag to suppress original response display
                    await sendMessage(originalText, { forcedLocation: loc });
                    return { retryTriggered: true };
                } catch (e) {
                    logger.error("❌ Failed to get fallback GPS", e);
                    // Retry with gps_unavailable flag so server doesn't request again
                    logger.info("📍 Retrying with GPS unavailable flag...");
                    await sendMessage(originalText, { gpsUnavailable: true });
                    return { retryTriggered: true };
                }
            }

            // Standard Service Call (Non-delayed)
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
                // Remove internal delay params if present
                delete serviceData.delay;
                delete serviceData.seconds;

                logger.info(`📡 Sending WS Message: ${domain}.${service}`, serviceData);

                try {
                    // Attempt 1
                    await haWebSocket.sendMessage({
                        type: 'call_service',
                        domain: domain,
                        service: service,
                        service_data: serviceData
                    }, 5000); // Short timeout for first try
                    logger.info(`✅ WS Message Sent`);
                } catch (wsErr: any) {
                    logger.warn(`⚠️ First attempt failed (${wsErr.message}). Status: ${haWebSocket.getStatus ? haWebSocket.getStatus() : 'Unknown'}. Retrying...`);

                    // Wait 1s and Retry
                    await new Promise(r => setTimeout(r, 1000));

                    try {
                        await haWebSocket.sendMessage({
                            type: 'call_service',
                            domain: domain,
                            service: service,
                            service_data: serviceData
                        }, 10000); // Longer timeout
                        logger.info(`✅ WS Message Sent (Retry)`);
                    } catch (retryErr: any) {
                        logger.error("❌ WS Send Failed after retry", retryErr);
                    }
                }
            } else if (action.action === 'open_url' || action.type === 'open_url') {
                const url = action.url || action.parameters?.url;
                if (url) {
                    logger.info(`🌐 Opening URL: ${url}`);

                    // Use _system for Google apps and YouTube to open in native apps
                    // Android will fall back to browser if app is not installed
                    const isGoogleApp = url.includes('docs.google.com') ||
                        url.includes('sheets.google.com') ||
                        url.includes('drive.google.com');
                    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');

                    if (isGoogleApp || isYouTube) {
                        logger.info(`📱 Opening in native app (if available): ${url}`);
                        window.open(url, '_system');
                    } else {
                        window.open(url, '_blank');
                    }
                } else {
                    logger.warn("⚠️ open_url action missing URL");
                }
            } else if (action.action === 'open_navigation' || action.type === 'open_navigation') {
                // Open Google Maps app in turn-by-turn navigation mode
                const destination = action.destination || action.parameters?.destination;
                const mode = action.mode || action.parameters?.mode || 'driving';

                if (destination) {
                    // Build Google Maps app deep link
                    // Modes: d = driving, w = walking, b = bicycling
                    const modeCode = mode === 'walking' ? 'w' : mode === 'bicycling' ? 'b' : 'd';
                    const navUrl = `google.navigation:q=${encodeURIComponent(destination)}&mode=${modeCode}`;

                    logger.info(`🗺️ Opening Google Maps Navigation to: ${destination} (mode: ${mode})`);
                    window.open(navUrl, '_system');
                } else {
                    logger.warn("⚠️ open_navigation action missing destination");
                }
            } else if (action.action === 'open_whatsapp' || action.type === 'open_whatsapp') {
                // Open WhatsApp with pre-filled message
                // Extract from action.parameters (LLM format) or direct properties
                const params = action.parameters || action.data || action;
                const phone = params.phone || action.phone || '';
                const name = params.name || action.name || '';
                const text = params.text || action.text || '';

                logger.info(`📱 WhatsApp action extracted: phone="${phone}", name="${name}", text="${text.substring(0, 30)}..."`);

                let finalPhone = phone.replace(/[^0-9+]/g, '');

                if (!finalPhone && name) {
                    logger.info(`🔍 Searching for contact: "${name}"`);
                    try {
                        const contact = await findContactByName(name);
                        if (contact && contact.phone) {
                            logger.info(`✅ Found contact: ${contact.name} (${contact.phone})`);
                            finalPhone = contact.phone.replace(/[^0-9+]/g, '');
                        } else {
                            logger.warn(`❌ Contact not found: "${name}"`);
                        }
                    } catch (contactErr: any) {
                        logger.error(`❌ Contact search error: ${contactErr.message}`);
                    }
                } else if (!finalPhone && !name) {
                    logger.warn(`⚠️ WhatsApp action missing both phone and name. Raw action: ${JSON.stringify(action)}`);
                }

                if (finalPhone) {
                    logger.info(`💬 Opening WhatsApp to: ${finalPhone} with message: "${text}"`);

                    // wa.me is the most reliable method - works on all devices
                    // Remove any non-digit characters except + at the start
                    const cleanPhone = finalPhone.replace(/^\+/, '').replace(/\D/g, '');
                    const encodedText = encodeURIComponent(text);
                    const waUrl = `https://wa.me/${cleanPhone}?text=${encodedText}`;

                    logger.info(`📲 Opening URL: ${waUrl}`);

                    try {
                        await Browser.open({ url: waUrl, presentationStyle: 'popover' });
                        logger.info('✅ WhatsApp URL opened');
                    } catch (e: any) {
                        logger.error(`❌ Failed to open WhatsApp: ${e.message}`);
                    }
                } else {
                    logger.warn(`❌ No phone number available for WhatsApp action (name was: "${name}")`);
                }
            } else if (action.action === 'open_sms' || action.type === 'open_sms') {
                // Open SMS app with pre-filled message
                const phone = action.phone || action.parameters?.phone || '';
                const name = action.name || action.parameters?.name || '';
                const text = action.text || action.parameters?.text || '';

                let finalPhone = phone.replace(/[^0-9+]/g, '');

                if (!finalPhone && name) {
                    logger.info(`🔍 Searching for contact for SMS: ${name}`);
                    const contact = await findContactByName(name);
                    if (contact && contact.phone) {
                        finalPhone = contact.phone.replace(/[^0-9+]/g, '');
                    }
                }

                if (finalPhone) {
                    logger.info(`📱 Opening SMS to: ${finalPhone} with message: "${text}"`);
                    const smsUrl = `sms:${finalPhone}?body=${encodeURIComponent(text)}`;
                    window.open(smsUrl, '_system');
                }
            } else if (action.action === 'open_line' || action.type === 'open_line') {
                // Open Line app with pre-filled message
                const text = action.text || action.parameters?.text || '';

                // Line deep link format: https://line.me/R/share?text=...
                // Use Browser.open for better Android intent handling
                const lineUrl = `https://line.me/R/share?text=${encodeURIComponent(text)}`;

                // Fallback scheme
                const lineScheme = `line://msg/text/${encodeURIComponent(text)}`;

                logger.info(`💬 Opening Line with message: "${text}"`);

                try {
                    await Browser.open({ url: lineUrl, presentationStyle: 'popover' });
                } catch (e) {
                    logger.warn('Standard Line URL failed, trying scheme...');
                    try {
                        await Browser.open({ url: lineScheme });
                    } catch (e2) {
                        logger.error('❌ Failed to open Line');
                    }
                }
            } else {
                logger.warn("⚠️ Action missing entity_id and not a recognized action, skipping:", action);
            }
        }

        // Refresh State after all actions
        return { retryTriggered: false };
    };

    const playNativeTTS = async (text: string, language: string, autoListen: boolean) => {
        try {
            // Use Capacitor TTS Plugin for reliable native voice
            const locale = (language && language.toLowerCase().includes('nl')) ? 'nl-NL' : 'en-US';

            logger.info(`🔊 Plugin TTS: "${text.substring(0, 20)}..." (${locale})`);

            await TextToSpeech.speak({
                text: text,
                lang: locale,
                rate: 1.0,
                pitch: 1.0,
                volume: 1.0,
                category: 'ambient',
            });

            logger.info('🔊 Plugin TTS Finished');

            if (autoListen) {
                logger.info('🎙️ Triggering auto-listen after TTS');
                (window as any).dispatchEvent(new CustomEvent('butler-auto-listen'));
            }

        } catch (e: any) {
            logger.error('❌ Plugin TTS failed, trying Web Speech fallback:', e);

            // Fallback to Web Speech API
            if ('speechSynthesis' in window) {
                const utter = new SpeechSynthesisUtterance(text);
                const locale = (language && language.toLowerCase().includes('nl')) ? 'nl-NL' : 'en-US';
                utter.lang = locale;

                utter.onend = () => {
                    if (autoListen) {
                        (window as any).dispatchEvent(new CustomEvent('butler-auto-listen'));
                    }
                };

                // Safety timeout for Web Speech
                setTimeout(() => {
                    if (window.speechSynthesis.speaking) {
                        logger.warn('⚠️ Native TTS timed out (fallback)');
                        if (autoListen) (window as any).dispatchEvent(new CustomEvent('butler-auto-listen'));
                    }
                }, (text.length * 100) + 2000);

                window.speechSynthesis.speak(utter);
            } else {
                if (autoListen) {
                    (window as any).dispatchEvent(new CustomEvent('butler-auto-listen'));
                }
            }
        }
    };

    const sendMessage = async (text: string, options?: { forcedLocation?: any; gpsUnavailable?: boolean; isWhisper?: boolean }) => {
        if (!activeConnection || !text.trim()) return;
        setLoading(true);
        // 0. Optimistic Update (Show user message immediately)
        const tempId = Date.now().toString();

        try {
            logger.info("Sending message", { text, connectionId: activeConnection.id, retry: !!options?.forcedLocation, gpsUnavailable: options?.gpsUnavailable });

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

            // 2. Build payload for Supabase Edge Function
            logger.info("Posting to process-ai-command", { deviceCount: devices.length });

            // Get MCP proxy URL from connection (if configured)
            const mcpProxyUrl = (activeConnection as any).mcp_proxy_url || undefined;

            // Try to get user's GPS location for weather/navigation
            let userLocation: { lat: number; lon: number } | null = null;

            if (options?.forcedLocation) {
                userLocation = options.forcedLocation;
                logger.info("📍 Using forced/fallback location", userLocation);
            } else if (!options?.gpsUnavailable) {
                try {
                    // "Immediate" fetch only: 300ms.
                    // If GPS is warm, we get it. If cold, we proceed without it to avoid blocking.
                    const getLocationPromise = Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 1000 });
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject("Timeout"), 300));

                    const position: any = await Promise.race([getLocationPromise, timeoutPromise]);
                    userLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
                    logger.info("📍 Got GPS location (Instant)", userLocation);
                } catch (e: any) {
                    // Determine if it was a timeout or error
                    if (typeof e === 'string' && e === 'Timeout') {
                        logger.info("📍 GPS too slow (skipped for speed)");
                    } else {
                        logger.warn("📍 GPS Error", e);
                    }
                }
            } else {
                logger.info("📍 Skipping GPS (marked as unavailable)");
            }

            const payload = {
                connection_id: activeConnection.id,
                user_message: text,
                language: uiState.language || 'en',
                devices: devices,
                mcp_proxy_url: mcpProxyUrl,
                ha_url: (activeConnection as any).api_url || '',
                ha_token: (activeConnection as any).token || (activeConnection as any).api_token || '',
                client_timestamp: new Date().toISOString(),
                client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                location: userLocation,
                gps_unavailable: options?.gpsUnavailable || false
            };
            logger.info("🔑 HA Credentials Debug:", {
                ha_url_length: payload.ha_url?.length || 0,
                ha_token_length: payload.ha_token?.length || 0,
                api_url_exists: !!(activeConnection as any).api_url,
                token_exists: !!(activeConnection as any).token,
                api_token_exists: !!(activeConnection as any).api_token
            });
            logger.info("📤 Payload Preview:", JSON.stringify(payload).substring(0, 500) + "...");

            let aiData: LLMResponse = {} as LLMResponse;

            // SUPABASE-BASED ARCHITECTURE: Call Edge Function directly
            // This works from anywhere - home or remote
            // The Edge Function handles all agent orchestration

            try {
                logger.info("🚀 Calling Supabase Edge Function...");

                const response = await fetch(`${SUPABASE_URL}/functions/v1/process-ai-command`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                    },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Supabase error: ${response.status} - ${errorText}`);
                }

                aiData = await response.json();
                logger.info("✅ Supabase Response Received", aiData);
            } catch (fetchError: any) {
                logger.error("Supabase call failed", fetchError);
                throw fetchError;
            }

            // Execute actions via WebSocket if we have a connection
            let retryTriggered = false;
            if (aiData.actions && aiData.actions.length > 0 && haWebSocket) {
                logger.info("🎯 Executing actions via WebSocket", { count: aiData.actions.length });
                const result = await executeActionsClientSide(aiData.actions, text);
                retryTriggered = result.retryTriggered;
            }

            // If a retry was triggered (e.g. GPS fallback), skip UI update for this response
            if (retryTriggered) {
                logger.info("🔄 Retry triggered - skipping UI update for original response");
                return; // The retry will handle UI update
            }

            logger.info("📥 Received AI Response", aiData);
            // This logs full object to Debug Tile

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

            // Handle Conversation Mode from AI response
            if (aiData.conversation_mode !== undefined) {
                setConversationMode(aiData.conversation_mode);
                if (aiData.conversation_mode) {
                    logger.info('🎙️ Conversation Mode: ACTIVATED (hands-free listening)');
                } else {
                    logger.info('🎙️ Conversation Mode: DEACTIVATED');
                }
            }

            // 4. TTS
            if (aiData.text) {
                // Deepgram Aura is English-optimized. For Dutch/Others, use Native TTS to avoid "Denglish" accent.
                const useDeepgram = (aiData.language === 'en' || !aiData.language);

                if (useDeepgram) {
                    try {
                        logger.info('🔊 Requesting Deepgram TTS...');

                        const ttsResponse = await fetch(`${SUPABASE_URL}/functions/v1/deepgram-tts`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                            },
                            body: JSON.stringify({
                                text: aiData.text,
                                language: aiData.language || 'en'
                            })
                        });

                        if (ttsResponse.ok) {
                            const { audio, contentType } = await ttsResponse.json();

                            // Convert base64 to audio blob
                            const binaryString = atob(audio);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                                bytes[i] = binaryString.charCodeAt(i);
                            }
                            const audioBlob = new Blob([bytes], { type: contentType || 'audio/mp3' });
                            const audioUrl = URL.createObjectURL(audioBlob);

                            // Play audio
                            const audioPlayer = new Audio(audioUrl);

                            // Whisper Mode: Lower volume
                            if (options?.isWhisper) {
                                audioPlayer.volume = 0.3;
                                logger.info('🤫 Whisper Mode: Responding quietly');
                            }

                            // Conversation Mode: Auto-listen after TTS finishes
                            audioPlayer.onended = () => {
                                URL.revokeObjectURL(audioUrl);
                                if (conversationMode || aiData.conversation_mode) {
                                    logger.info('🎙️ TTS ended, triggering auto-listen for conversation mode');
                                    window.dispatchEvent(new CustomEvent('butler-auto-listen'));
                                }
                            };

                            audioPlayer.play().catch(e => {
                                logger.error('❌ Failed to play audio:', e);
                                // Fallback to Web Speech API
                                playNativeTTS(aiData.text, aiData.language, conversationMode || !!aiData.conversation_mode);
                            });

                            logger.info('🔊 Deepgram TTS playing');
                        } else {
                            logger.warn('⚠️ Deepgram TTS failed, falling back to Web Speech API');
                            playNativeTTS(aiData.text, aiData.language, conversationMode || !!aiData.conversation_mode);
                        }
                    } catch (ttsError) {
                        logger.error('❌ TTS error:', ttsError);
                        playNativeTTS(aiData.text, aiData.language, conversationMode || !!aiData.conversation_mode);
                    }
                } else {
                    // Non-English: Use Native TTS directly
                    logger.info(`🔊 Using Native TTS for language: ${aiData.language}`);
                    playNativeTTS(aiData.text, aiData.language, conversationMode || !!aiData.conversation_mode);
                }
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

    return { messages, setMessages, sendMessage, loading, conversationMode, setConversationMode };
}
