/**
 * Deepgram STT WebSocket Proxy
 * 
 * Proxies WebSocket connections between the mobile app and Deepgram Nova-3.
 * Keeps API key secure on the server side.
 * 
 * Flow:
 * 1. App connects via WebSocket with language param
 * 2. Function connects to Deepgram with API key
 * 3. Audio flows: App -> This Proxy -> Deepgram
 * 4. Transcripts flow: Deepgram -> This Proxy -> App
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const DEEPGRAM_API_KEY = Deno.env.get('DEEPGRAM_API_KEY');

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, upgrade, connection, sec-websocket-key, sec-websocket-version, sec-websocket-protocol',
};

serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    // Check for WebSocket upgrade
    const upgradeHeader = req.headers.get('upgrade');
    if (upgradeHeader?.toLowerCase() !== 'websocket') {
        return new Response(JSON.stringify({
            error: 'This endpoint requires a WebSocket connection',
            usage: 'Connect via WebSocket with ?language=en-US (optional)'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    if (!DEEPGRAM_API_KEY) {
        return new Response(JSON.stringify({ error: 'Deepgram API key not configured' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // Parse URL params
    const url = new URL(req.url);
    const language = url.searchParams.get('language') || 'multi'; // 'multi' = auto-detect
    const sampleRate = url.searchParams.get('sample_rate');

    console.log(`[Deepgram] New connection - Language: ${language}, Sample Rate: ${sampleRate}`);

    // Upgrade to WebSocket
    const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

    // Connect to Deepgram
    const encoding = url.searchParams.get('encoding');

    // Normalize language code for Deepgram
    // Deepgram supports: nl, en, de, fr, es, etc. (ISO 639-1)
    // Regional variants like 'nl-BE' should be simplified to base language
    let normalizedLanguage = language;
    if (language.includes('-')) {
        normalizedLanguage = language.split('-')[0]; // nl-BE -> nl, en-US -> en
    }
    // Special case: 'multi' means auto-detect
    if (normalizedLanguage === 'multi') {
        normalizedLanguage = 'multi'; // Keep as-is for Deepgram auto-detect
    }

    console.log(`[Deepgram] Normalized language: ${language} -> ${normalizedLanguage}`);

    // Base params - use nova-2 (state of the art as of 2025)
    const deepgramParamsObj: Record<string, string> = {
        model: 'nova-2',  // Fixed: nova-3 doesn't exist, nova-2 is the latest
        language: normalizedLanguage,
        punctuate: 'true',
        interim_results: 'true',
        smart_format: 'true',
        endpointing: '300',
        utterance_end_ms: '1000'
    };

    // Add encoding-specific params only if encoding is provided (for raw PCM)
    // For container formats (webm/opus), omit them to let Deepgram auto-detect
    if (encoding && encoding !== 'undefined' && encoding !== 'null') {
        deepgramParamsObj.encoding = encoding;
        if (sampleRate) deepgramParamsObj.sample_rate = sampleRate;
        deepgramParamsObj.channels = '1';
    }

    const deepgramParams = new URLSearchParams(deepgramParamsObj);

    const deepgramUrl = `wss://api.deepgram.com/v1/listen?${deepgramParams.toString()}`;

    let deepgramSocket: WebSocket | null = null;
    let isClosing = false;

    clientSocket.onopen = () => {
        console.log('[Deepgram] Client connected, connecting to Deepgram...');
        console.log('[Deepgram] API Key present:', !!DEEPGRAM_API_KEY, 'Length:', DEEPGRAM_API_KEY?.length);

        // Deepgram requires auth
        // Use subprotocol for authentication
        try {
            deepgramSocket = new WebSocket(deepgramUrl, ['token', DEEPGRAM_API_KEY]);
        } catch (e) {
            console.error('[Deepgram] Failed to create WebSocket:', e);
            clientSocket.send(JSON.stringify({ type: 'error', message: 'Failed to connect to Deepgram' }));
            clientSocket.close();
            return;
        }

        deepgramSocket.onopen = () => {
            console.log('[Deepgram] Connected to Deepgram API');
            // Notify client that we're ready
            if (clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.send(JSON.stringify({ type: 'ready' }));
            }
        };

        deepgramSocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Forward transcription to client
                if (data.channel?.alternatives?.[0]?.transcript) {
                    const transcript = data.channel.alternatives[0].transcript;
                    const isFinal = data.is_final === true;
                    const speechFinal = data.speech_final === true;

                    if (transcript.trim()) {
                        console.log(`[Deepgram] ${isFinal ? 'FINAL' : 'interim'}: "${transcript}"`);
                        if (clientSocket.readyState === WebSocket.OPEN) {
                            clientSocket.send(JSON.stringify({
                                type: 'transcript',
                                transcript: transcript,
                                is_final: isFinal,
                                speech_final: speechFinal,
                                confidence: data.channel.alternatives[0].confidence
                            }));
                        }
                    }
                }

                // Handle utterance end (natural pause in speech)
                if (data.type === 'UtteranceEnd') {
                    console.log('[Deepgram] Utterance end detected');
                    if (clientSocket.readyState === WebSocket.OPEN) {
                        clientSocket.send(JSON.stringify({ type: 'utterance_end' }));
                    }
                }
            } catch (e) {
                console.error('[Deepgram] Parse error:', e);
            }
        };

        deepgramSocket.onerror = (error: any) => {
            console.error('[Deepgram] Deepgram error:', error?.message || error);
            if (!isClosing && clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.send(JSON.stringify({ type: 'error', message: 'Deepgram connection error: ' + (error?.message || 'unknown') }));
            }
        };

        deepgramSocket.onclose = (event) => {
            console.log(`[Deepgram] Deepgram closed: ${event.code} ${event.reason}`);
            if (!isClosing && clientSocket.readyState === WebSocket.OPEN) {
                isClosing = true;
                clientSocket.close();
            }
        };
    };

    clientSocket.onmessage = (event) => {
        // Forward audio data to Deepgram
        if (deepgramSocket?.readyState === WebSocket.OPEN) {
            if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
                deepgramSocket.send(event.data);
            } else if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'close') {
                        console.log('[Deepgram] Client requested close');
                        isClosing = true;
                        deepgramSocket.close();
                    } else if (msg.type === 'keepalive') {
                        // Keep connection alive
                        deepgramSocket.send(JSON.stringify({ type: 'KeepAlive' }));
                    }
                } catch {
                    // Not JSON, might be base64 audio - decode and forward
                    try {
                        const binaryData = Uint8Array.from(atob(event.data), c => c.charCodeAt(0));
                        deepgramSocket.send(binaryData.buffer);
                    } catch (e) {
                        console.warn('[Deepgram] Unknown string data received');
                    }
                }
            }
        }
    };

    clientSocket.onerror = (error) => {
        console.error('[Deepgram] Client error:', error);
    };

    clientSocket.onclose = () => {
        console.log('[Deepgram] Client disconnected');
        isClosing = true;
        if (deepgramSocket?.readyState === WebSocket.OPEN) {
            deepgramSocket.close();
        }
    };

    return response;
});
