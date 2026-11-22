/// <reference types="vite/client" />
import { useState, useRef } from 'react';
import { useApp } from '../AppContext';
import { ChatMessage, LLMResponse } from '../../types';
import { logger } from '../../utils/logger';
import { Geolocation } from '@capacitor/geolocation';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { findContactByName } from '../../utils/contactsService';
import { supabase } from '../supabase';
// @ts-ignore
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { runClientReActOrchestrator, resolveAIConfig } from '../services/clientOrchestrator';

const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL || '';

// Module-level GPS cache so subsequent questions don't require GPS warm-up or server retry
let lastKnownLocation: { lat: number; lon: number; timestamp: number } | null = null;

// Global callback for graph creation (set by App.tsx)
export let onGraphCreate: ((config: any) => void) | null = null;
export const setGraphCreateCallback = (cb: ((config: any) => void) | null) => { onGraphCreate = cb; };

export function useAIChatLogic() {
    const { activeConnection, entityStates, haWebSocket, addChatMessage, uiState } = useApp();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loading, setLoading] = useState(false);
    const [conversationMode, setConversationMode] = useState(false);
    const isSendingRef = useRef(false);
    const activeAudioRef = useRef<HTMLAudioElement | null>(null);
    const activeAudioUrlRef = useRef<string | null>(null);
    const ttsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const getDynamicCoordinates = (): { lat: number; lon: number } | null => {
        if (lastKnownLocation) return { lat: lastKnownLocation.lat, lon: lastKnownLocation.lon };
        try {
            const homeZone: any = entityStates?.['zone.home'];
            const homeLat = homeZone?.attributes?.latitude;
            const homeLon = homeZone?.attributes?.longitude;
            if (typeof homeLat === 'number' && typeof homeLon === 'number') {
                return { lat: homeLat, lon: homeLon };
            }
        } catch { }
        return null;
    };

    // Local Execution Helper
    const executeActionsClientSide = async (actions: any[], originalText?: string): Promise<{ retryTriggered: boolean; generatedText?: string }> => {
        let generatedText: string | undefined = undefined;
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

                if (targetAction && targetAction.entity_id && targetAction.service && haWebSocket) {
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
                    lastKnownLocation = { ...loc, timestamp: Date.now() };
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

            // If already executed by Client Orchestrator or is an informational tool, do not call HA
            if (
                action.result === 'success' ||
                action.executedLocally ||
                ['weather', 'navigation', 'energy', 'info', 'query', 'history', 'logbook', 'camera', 'todo', 'calendar', 'automation', 'search'].includes(action.type) ||
                (typeof action.entity_id === 'string' && (
                    action.entity_id.startsWith('weather.open_meteo') ||
                    action.entity_id.startsWith('device.navigation') ||
                    action.entity_id.startsWith('sensor.energy_prices')
                ))
            ) {
                logger.info("ℹ️ Skipping HA service execution for local/completed action", action);
                continue;
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

                let executed = false;

                // 1. WebSocket Call (only if connected and authenticated)
                if (haWebSocket && typeof haWebSocket.isConnected === 'function' && haWebSocket.isConnected()) {
                    logger.info(`📡 Sending WS Message: ${domain}.${service}`, serviceData);
                    try {
                        await haWebSocket.sendMessage({
                            type: 'call_service',
                            domain: domain,
                            service: service,
                            service_data: serviceData
                        }, 3000);
                        logger.info(`✅ WS Message Sent`);
                        executed = true;
                    } catch (wsErr: any) {
                        logger.warn(`⚠️ WS service call failed, trying REST fallback:`, wsErr);
                    }
                }

                // 2. Direct REST API execution (Fast fallback if WS is not connected or timed out)
                if (!executed) {
                    const apiUrl = (activeConnection as any)?.api_url;
                    const apiToken = (activeConnection as any)?.token || (activeConnection as any)?.api_token;
                    if (apiUrl && apiToken) {
                        try {
                            const { callHAService } = await import('../../utils/home-assistant');
                            await callHAService(domain, service, serviceData, apiUrl, apiToken);
                            logger.info(`✅ HA Service executed via REST: ${domain}.${service}`);
                            executed = true;
                        } catch (restErr: any) {
                            logger.error("❌ HA REST service execution failed", restErr);
                        }
                    } else {
                        logger.warn("⚠️ Cannot execute HA service: WebSocket not connected and no REST credentials", action);
                    }
                }
                continue;
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

                    if (Capacitor.isNativePlatform()) {
                        await Browser.open({ url });
                    } else {
                        window.open(url, '_blank', 'noopener,noreferrer');
                    }
                } else {
                    logger.warn("⚠️ open_url action missing URL");
                }
            } else if (action.action === 'open_navigation' || action.type === 'open_navigation') {
                // Open Google Maps app in turn-by-turn navigation mode
                const destination = action.destination || action.parameters?.destination;
                const mode = action.mode || action.parameters?.mode || 'driving';

                if (destination) {
                    const modeCode = mode === 'walking' ? 'w' : mode === 'bicycling' ? 'b' : 'd';
                    const navUrl = `google.navigation:q=${encodeURIComponent(destination)}&mode=${modeCode}`;
                    const webMaps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=${mode}`;

                    logger.info(`🗺️ Opening Navigation to: ${destination} (mode: ${mode})`);
                    if (Capacitor.isNativePlatform()) {
                        try {
                            await Browser.open({ url: navUrl });
                        } catch {
                            await Browser.open({ url: webMaps });
                        }
                    } else {
                        window.open(webMaps, '_blank', 'noopener,noreferrer');
                    }
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
        return { retryTriggered: false, generatedText };
    };

    const stopCurrentSpeech = () => {
        if (ttsTimeoutRef.current) {
            clearTimeout(ttsTimeoutRef.current);
            ttsTimeoutRef.current = null;
        }
        if (activeAudioRef.current) {
            try {
                activeAudioRef.current.pause();
                activeAudioRef.current.onended = null;
                activeAudioRef.current.onerror = null;
            } catch { }
            activeAudioRef.current = null;
        }
        if (activeAudioUrlRef.current) {
            URL.revokeObjectURL(activeAudioUrlRef.current);
            activeAudioUrlRef.current = null;
        }
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            try { window.speechSynthesis.cancel(); } catch { }
        }
        if (Capacitor.isNativePlatform()) {
            try { TextToSpeech.stop().catch(() => {}); } catch { }
        }
    };

    const playNativeTTS = async (text: string, language: string, autoListen: boolean, isWhisper?: boolean) => {
        stopCurrentSpeech();
        const isDutch = !language || language.toLowerCase().startsWith('nl');
        const locale = isDutch ? 'nl-NL' : 'en-US';
        const volume = isWhisper ? 0.3 : 1.0;
        const rate = isWhisper ? 0.9 : 1.05;
        const pitch = isWhisper ? 0.85 : 1.0;

        try {
            if (Capacitor.isNativePlatform()) {
                await TextToSpeech.speak({
                    text,
                    lang: locale,
                    rate,
                    pitch,
                    volume,
                    category: 'ambient',
                });
                if (autoListen) {
                    window.dispatchEvent(new CustomEvent('butler-auto-listen'));
                }
                return;
            }
            throw new Error('Web platform - use Web Speech');
        } catch {
            if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                const utter = new SpeechSynthesisUtterance(text);
                utter.lang = locale;
                utter.volume = volume;
                utter.rate = rate;
                utter.pitch = pitch;

                const voices = window.speechSynthesis.getVoices();
                const targetPrefix = isDutch ? 'nl' : 'en';
                const matchingVoice = voices.find(v => v.lang.toLowerCase().startsWith(targetPrefix));
                if (matchingVoice) {
                    utter.voice = matchingVoice;
                }

                const finish = () => {
                    if (ttsTimeoutRef.current) {
                        clearTimeout(ttsTimeoutRef.current);
                        ttsTimeoutRef.current = null;
                    }
                    if (autoListen) {
                        window.dispatchEvent(new CustomEvent('butler-auto-listen'));
                    }
                };

                utter.onend = finish;
                utter.onerror = finish;

                ttsTimeoutRef.current = setTimeout(() => {
                    ttsTimeoutRef.current = null;
                    if (window.speechSynthesis.speaking) {
                        window.speechSynthesis.cancel();
                    }
                    if (autoListen) {
                        window.dispatchEvent(new CustomEvent('butler-auto-listen'));
                    }
                }, Math.min(30000, (text.length * 100) + 4000));

                window.speechSynthesis.speak(utter);
            } else if (autoListen) {
                globalThis.dispatchEvent(new CustomEvent('butler-auto-listen'));
            }
        }
    };

    const sendMessage = async (text: string, options?: { forcedLocation?: any; gpsUnavailable?: boolean; isWhisper?: boolean }) => {
        if (!activeConnection || !text.trim()) return;
        if (isSendingRef.current && !options?.forcedLocation) {
            logger.warn('⏳ Ignoring duplicate sendMessage while already processing');
            return;
        }
        isSendingRef.current = true;
        setLoading(true);
        stopCurrentSpeech();

        const tempId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        try {
            logger.info('Sending message', { textLength: text.length, connectionId: activeConnection.id });

            const optimisticMsg: ChatMessage = {
                id: tempId,
                connection_id: activeConnection.id,
                user_message: text,
                ai_response: '',
                language: uiState.language || 'nl',
                actions_taken: [],
                created_at: new Date().toISOString()
            };
            setMessages(prev => [...prev, optimisticMsg]);

            // 1. Gather Context
            let devices = Object.values(entityStates || {}).map((s: any) => ({
                entity_id: s.entity_id, ...s
            })).filter(d => d.entity_id);

            if (devices.length === 0 && activeConnection) {
                try {
                    const cachedStatesRaw = localStorage.getItem(`ha_entity_states_${activeConnection.id}`);
                    if (cachedStatesRaw) {
                        const statesObj = JSON.parse(cachedStatesRaw);
                        if (statesObj && typeof statesObj === 'object') {
                            devices = Object.values(statesObj).filter((d: any) => d?.entity_id);
                        }
                    }
                    if (devices.length === 0) {
                        const cachedTilesRaw = localStorage.getItem(`dashboard_tiles_${activeConnection.id}`);
                        if (cachedTilesRaw) {
                            const tiles = JSON.parse(cachedTilesRaw);
                            const extracted: any[] = [];
                            if (Array.isArray(tiles)) {
                                tiles.forEach((t: any) => {
                                    if (Array.isArray(t.deviceGroups)) {
                                        t.deviceGroups.forEach((g: any) => {
                                            (g.entities || []).forEach((d: any) => {
                                                const eid = d.entityId || d.entity_id;
                                                if (eid) extracted.push({ entity_id: eid, state: 'unknown', attributes: { friendly_name: d.name } });
                                            });
                                        });
                                    } else if (Array.isArray(t.devices)) {
                                        t.devices.forEach((d: any) => {
                                            const eid = d.entityId || d.entity_id;
                                            if (eid) extracted.push({ entity_id: eid, state: d.state || 'unknown', attributes: { friendly_name: d.name } });
                                        });
                                    }
                                });
                            }
                            if (extracted.length > 0) devices = extracted;
                        }
                    }
                } catch (cacheErr) {
                    logger.warn('Failed to parse cached devices:', cacheErr);
                }
            }

            // 2. Acquire GPS / home coordinates
            let userLocation: { lat: number; lon: number } | null = null;
            if (options?.forcedLocation) {
                userLocation = options.forcedLocation;
                lastKnownLocation = { ...options.forcedLocation, timestamp: Date.now() };
            } else if (lastKnownLocation && (Date.now() - lastKnownLocation.timestamp < 30 * 60 * 1000)) {
                userLocation = { lat: lastKnownLocation.lat, lon: lastKnownLocation.lon };
            } else if (!options?.gpsUnavailable) {
                try {
                    const getLocationPromise = Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 1500 });
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject('Timeout'), 1200));
                    const position: any = await Promise.race([getLocationPromise, timeoutPromise]);
                    userLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
                    lastKnownLocation = { ...userLocation, timestamp: Date.now() };
                } catch { }
            }

            if (!userLocation) {
                const dynCoords = getDynamicCoordinates();
                if (dynCoords) userLocation = dynCoords;
            }

            const recentHistory = messages.slice(-6).map(m => ([
                { role: 'user', content: m.user_message },
                { role: 'assistant', content: m.ai_response }
            ])).flat().filter(m => m.content && m.content.trim());

            let aiData: LLMResponse = {} as LLMResponse;
            const aiConfig = resolveAIConfig();

            if (aiConfig.apiKey) {
                try {
                    logger.info(`🧠 Running SOTA Unified ReAct [${aiConfig.provider.toUpperCase()} - ${aiConfig.model}] (${devices.length} entities)`);
                    aiData = await runClientReActOrchestrator({
                        apiKey: aiConfig.apiKey,
                        model: aiConfig.model,
                        provider: aiConfig.provider,
                        userMessage: text,
                        recentHistory,
                        language: uiState.language || 'nl',
                        devices,
                        haUrl: activeConnection.api_url,
                        haToken: activeConnection.api_token || activeConnection.token,
                        haWebSocket,
                        location: userLocation,
                        connectionId: activeConnection.id
                    });
                } catch (clientErr: any) {
                    logger.error('Client ReAct Orchestrator error:', clientErr);
                    aiData = {
                        text: (uiState.language || 'nl').startsWith('nl')
                            ? `Fout bij uitvoeren van AI: ${clientErr?.message || 'Onbekende fout'}. Controleer je Gemini / OpenRouter API-sleutel in Instellingen.`
                            : `AI execution error: ${clientErr?.message || 'Unknown error'}. Please check your Gemini / OpenRouter API key in Settings.`,
                        actions: [],
                        language: uiState.language || 'nl',
                        confidence: 0,
                        logs: [`[Client] Error: ${clientErr?.message}`]
                    };
                }
            } else {
                aiData = {
                    text: (uiState.language || 'nl').startsWith('nl')
                        ? 'Vul eenmalig je Gemini (of OpenRouter) API-sleutel in via Instellingen (⚙️) om Butler AI te activeren.'
                        : 'Please enter your Gemini (or OpenRouter) API key in Settings (⚙️) to activate Butler AI.',
                    actions: [],
                    language: uiState.language || 'nl',
                    confidence: 1.0,
                    logs: ['[Client] No API key configured.']
                };
            }

            // Execute non-locally-executed client actions (timers, alarms, graphs, etc.)
            let retryTriggered = false;
            let actionGeneratedText: string | undefined = undefined;
            const clientPendingActions = (aiData.actions || []).filter(a => !a.executedLocally);
            if (clientPendingActions.length > 0) {
                const result = await executeActionsClientSide(clientPendingActions, text);
                retryTriggered = result.retryTriggered;
                actionGeneratedText = result.generatedText;
            }

            if (retryTriggered) {
                setMessages(prev => prev.filter(m => m.id !== tempId));
                return;
            }

            const responseText = aiData.text || actionGeneratedText || (
                (uiState.language || 'nl').startsWith('nl')
                    ? 'Ik kon geen antwoord genereren. Probeer het nog eens.'
                    : 'I could not generate an answer. Please try again.'
            );

            const responseLanguage = aiData.language || uiState.language || 'nl-BE';

            // 3. UI Update
            const completedMsg: ChatMessage = {
                ...optimisticMsg,
                ai_response: responseText,
                language: responseLanguage,
                actions_taken: aiData.actions || [],
                scheduled_actions: aiData.scheduled_actions || []
            };

            setMessages(prev => prev.map(m => m.id === tempId ? completedMsg : m));
            addChatMessage(completedMsg);

            // 4. Persist NEW row to Supabase chat_history (strip large base64 camera images before DB insert!)
            try {
                const sanitizedActions = (aiData.actions || []).map(a => {
                    if (a.type === 'camera' && a.data?.snapshot_data_url) {
                        const { snapshot_data_url: _omitted, ...restData } = a.data;
                        return { ...a, data: restData };
                    }
                    return a;
                });

                const { error: insertErr } = await supabase.from('chat_history').insert({
                    connection_id: activeConnection.id,
                    user_message: text,
                    ai_response: { text: responseText, actions: sanitizedActions },
                    actions_taken: sanitizedActions,
                    metadata: { language: responseLanguage }
                });
                if (insertErr) {
                    logger.warn('⚠️ chat_history insert error:', insertErr.message);
                }
            } catch (persistErr) {
                logger.warn('⚠️ Failed to persist chat history to Supabase:', persistErr);
            }

            if (aiData.conversation_mode !== undefined) {
                setConversationMode(aiData.conversation_mode);
            }

            // 5. TTS Playback
            if (responseText) {
                const isEnglish = responseLanguage.toLowerCase().startsWith('en');
                const shouldAutoListen = conversationMode || !!aiData.conversation_mode;

                if (isEnglish && SUPABASE_URL) {
                    try {
                        const { data: sessionData } = await supabase.auth.getSession();
                        const jwt = sessionData?.session?.access_token;
                        if (!jwt) throw new Error('No session JWT for TTS');

                        const ttsResponse = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/deepgram-tts`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${jwt}`
                            },
                            body: JSON.stringify({ text: responseText, language: responseLanguage })
                        });

                        if (ttsResponse.ok) {
                            const { audio, contentType } = await ttsResponse.json();
                            const binaryString = atob(audio);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                                bytes[i] = binaryString.charCodeAt(i);
                            }
                            const audioBlob = new Blob([bytes], { type: contentType || 'audio/mp3' });
                            const audioUrl = URL.createObjectURL(audioBlob);
                            const audioPlayer = new Audio(audioUrl);
                            activeAudioRef.current = audioPlayer;
                            activeAudioUrlRef.current = audioUrl;

                            if (options?.isWhisper) audioPlayer.volume = 0.3;

                            const cleanupAudio = () => {
                                if (activeAudioUrlRef.current === audioUrl) {
                                    URL.revokeObjectURL(audioUrl);
                                    activeAudioUrlRef.current = null;
                                }
                                if (activeAudioRef.current === audioPlayer) {
                                    activeAudioRef.current = null;
                                }
                            };

                            audioPlayer.onended = () => {
                                cleanupAudio();
                                if (shouldAutoListen) {
                                    window.dispatchEvent(new CustomEvent('butler-auto-listen'));
                                }
                            };
                            audioPlayer.onerror = () => {
                                cleanupAudio();
                                playNativeTTS(responseText, responseLanguage, shouldAutoListen, options?.isWhisper);
                            };

                            audioPlayer.play().catch(() => {
                                cleanupAudio();
                                playNativeTTS(responseText, responseLanguage, shouldAutoListen, options?.isWhisper);
                            });
                        } else {
                            playNativeTTS(responseText, responseLanguage, shouldAutoListen, options?.isWhisper);
                        }
                    } catch {
                        playNativeTTS(responseText, responseLanguage, shouldAutoListen, options?.isWhisper);
                    }
                } else {
                    playNativeTTS(responseText, responseLanguage, shouldAutoListen, options?.isWhisper);
                }
            }
        } catch (e: any) {
            logger.error('AI Logic Exception', e);
            const errorMsg: ChatMessage = {
                id: tempId,
                connection_id: activeConnection.id,
                user_message: text,
                ai_response: `⚠️ Fout: ${e?.message || 'Netwerkfout'}`,
                language: uiState.language || 'nl',
                actions_taken: [],
                created_at: new Date().toISOString()
            };
            setMessages(prev => prev.map(m => m.id === tempId ? errorMsg : m));
            addChatMessage(errorMsg);
        } finally {
            isSendingRef.current = false;
            setLoading(false);
        }
    };

    return { messages, setMessages, sendMessage, loading, conversationMode, setConversationMode };
}
