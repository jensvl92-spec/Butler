/**
 * Deepgram STT WebSocket Proxy
 * Authenticated WebSocket proxy between Butler App and Deepgram Nova-3.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEEPGRAM_API_KEY = Deno.env.get('DEEPGRAM_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, upgrade, connection, sec-websocket-key, sec-websocket-version, sec-websocket-protocol',
};

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const upgradeHeader = req.headers.get('upgrade');
    if (upgradeHeader?.toLowerCase() !== 'websocket') {
        return new Response(JSON.stringify({
            error: 'This endpoint requires a WebSocket connection',
            usage: 'Connect via WebSocket with ?language=nl&token=<jwt>'
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

    const url = new URL(req.url);
    const authHeader = (req.headers.get('Authorization') || '').trim();
    const bearer = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : (url.searchParams.get('token') || '').trim();

    if (!bearer) {
        return new Response(JSON.stringify({ error: 'Unauthorized: missing user token' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: authErr } = await supabaseAdmin.auth.getUser(bearer);
    if (authErr || !userData?.user?.id) {
        return new Response(JSON.stringify({ error: 'Unauthorized: invalid or expired token' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    const language = url.searchParams.get('language') || 'multi';
    const sampleRate = url.searchParams.get('sample_rate');
    const encoding = url.searchParams.get('encoding');

    let normalizedLanguage = language;
    if (language.includes('-')) {
        normalizedLanguage = language.split('-')[0];
    }

    const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

    const deepgramParamsObj: Record<string, string> = {
        model: 'nova-3',
        language: normalizedLanguage,
        punctuate: 'true',
        interim_results: 'true',
        smart_format: 'true',
        endpointing: '300',
        utterance_end_ms: '1000'
    };

    if (encoding && encoding !== 'undefined' && encoding !== 'null') {
        deepgramParamsObj.encoding = encoding;
        if (sampleRate) deepgramParamsObj.sample_rate = sampleRate;
        deepgramParamsObj.channels = '1';
    }

    const deepgramUrl = `wss://api.deepgram.com/v1/listen?${new URLSearchParams(deepgramParamsObj).toString()}`;
    let deepgramSocket: WebSocket | null = null;
    let isClosing = false;

    clientSocket.onopen = () => {
        try {
            deepgramSocket = new WebSocket(deepgramUrl, ['token', DEEPGRAM_API_KEY]);
        } catch (e) {
            console.error('[Deepgram] Failed to create WebSocket:', e);
            clientSocket.send(JSON.stringify({ type: 'error', message: 'Failed to connect to Deepgram' }));
            clientSocket.close();
            return;
        }

        deepgramSocket.onopen = () => {
            if (clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.send(JSON.stringify({ type: 'ready' }));
            }
        };

        deepgramSocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.channel?.alternatives?.[0]?.transcript) {
                    const transcript = data.channel.alternatives[0].transcript;
                    if (transcript.trim() && clientSocket.readyState === WebSocket.OPEN) {
                        clientSocket.send(JSON.stringify({
                            type: 'transcript',
                            transcript,
                            is_final: data.is_final === true,
                            speech_final: data.speech_final === true,
                            confidence: data.channel.alternatives[0].confidence
                        }));
                    }
                }
                if (data.type === 'UtteranceEnd' && clientSocket.readyState === WebSocket.OPEN) {
                    clientSocket.send(JSON.stringify({ type: 'utterance_end' }));
                }
            } catch (e) {
                console.error('[Deepgram] Parse error:', e);
            }
        };

        deepgramSocket.onerror = (error: any) => {
            if (!isClosing && clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.send(JSON.stringify({ type: 'error', message: 'Deepgram connection error: ' + (error?.message || 'unknown') }));
            }
        };

        deepgramSocket.onclose = () => {
            if (!isClosing && clientSocket.readyState === WebSocket.OPEN) {
                isClosing = true;
                clientSocket.close();
            }
        };
    };

    clientSocket.onmessage = (event) => {
        if (deepgramSocket?.readyState === WebSocket.OPEN) {
            if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
                deepgramSocket.send(event.data);
            } else if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'close') {
                        isClosing = true;
                        deepgramSocket.close();
                    } else if (msg.type === 'keepalive') {
                        deepgramSocket.send(JSON.stringify({ type: 'KeepAlive' }));
                    }
                } catch {
                    try {
                        const binaryData = Uint8Array.from(atob(event.data), c => c.charCodeAt(0));
                        deepgramSocket.send(binaryData.buffer);
                    } catch {
                        // ignore malformed frame
                    }
                }
            }
        }
    };

    clientSocket.onclose = () => {
        isClosing = true;
        if (deepgramSocket?.readyState === WebSocket.OPEN) {
            deepgramSocket.close();
        }
    };

    return response;
});
