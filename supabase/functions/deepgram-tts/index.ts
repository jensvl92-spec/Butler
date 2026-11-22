/**
 * Deepgram TTS - Text-to-Speech Edge Function
 * Authenticated proxy to Deepgram Aura-2 with valid Dutch & English voices and O(N) base64 encoding.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRequestAuth, CORS_HEADERS } from "../_shared/auth.ts";
import { fetchWithTimeout } from "../_shared/model-registry.ts";

const DEEPGRAM_API_KEY = Deno.env.get('DEEPGRAM_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const VOICES: Record<string, string> = {
    'en': 'aura-2-asteria-en',
    'en-us': 'aura-2-asteria-en',
    'en-gb': 'aura-2-luna-en',
    'nl': 'aura-2-sander-nl',
    'nl-nl': 'aura-2-sander-nl',
    'nl-be': 'aura-2-sander-nl',
    'default': 'aura-2-sander-nl'
};

const MAX_TEXT_LENGTH = 2000;

function uint8ToBase64(bytes: Uint8Array): string {
    const CHUNK_SIZE = 0x8000;
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE)));
    }
    return btoa(chunks.join(''));
}

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: CORS_HEADERS });
    }

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) {
            return new Response(JSON.stringify({ error: auth.error }), {
                status: auth.status || 401,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }

        if (!DEEPGRAM_API_KEY) {
            return new Response(JSON.stringify({ error: 'Deepgram API key not configured' }), {
                status: 500,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }

        const { text, language = 'nl', voice: customVoice } = await req.json();
        if (!text || typeof text !== 'string' || !text.trim()) {
            return new Response(JSON.stringify({ error: 'No text provided' }), {
                status: 400,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }

        const cleanText = text.trim().slice(0, MAX_TEXT_LENGTH);
        const langKey = String(language || 'nl').toLowerCase();
        const baseLang = langKey.split('-')[0];

        let voice = VOICES[langKey] || VOICES[baseLang] || VOICES['default'];
        if (typeof customVoice === 'string' && /^aura-[a-z0-9-]+$/i.test(customVoice)) {
            voice = customVoice;
        }

        const response = await fetchWithTimeout(
            `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Token ${DEEPGRAM_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text: cleanText })
            },
            20000
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[TTS] Deepgram error:', response.status, errorText);
            return new Response(JSON.stringify({ error: 'TTS generation failed', details: errorText.slice(0, 200) }), {
                status: response.status,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }

        const audioBuffer = await response.arrayBuffer();
        const base64Audio = uint8ToBase64(new Uint8Array(audioBuffer));

        return new Response(JSON.stringify({
            audio: base64Audio,
            contentType: 'audio/mp3',
            voice,
            textLength: cleanText.length
        }), {
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });

    } catch (error: any) {
        console.error('[TTS] Error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }
});
