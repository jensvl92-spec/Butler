/**
 * Deepgram TTS - Text-to-Speech Edge Function
 * 
 * Proxies requests to Deepgram Aura for reliable TTS on Android.
 * Returns audio as base64 or streaming audio data.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const DEEPGRAM_API_KEY = Deno.env.get('DEEPGRAM_API_KEY')!;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Available Deepgram Aura voices
const VOICES = {
    'en': 'aura-asteria-en',      // Female, American English
    'en-us': 'aura-asteria-en',
    'en-gb': 'aura-luna-en',      // Female, British English
    'nl': 'aura-orion-en',        // Male, neutral (Dutch not natively supported, use neutral English)
    'nl-nl': 'aura-orion-en',
    'nl-be': 'aura-orion-en',
    'default': 'aura-asteria-en'
};

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { text, language = 'en', voice: customVoice } = await req.json();

        if (!text) {
            return new Response(JSON.stringify({ error: 'No text provided' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Select voice based on language or use custom
        const langKey = language.toLowerCase();
        const voice = customVoice || VOICES[langKey] || VOICES['default'];

        console.log(`[TTS] Generating speech for: "${text.substring(0, 50)}..." using voice: ${voice}`);

        // Call Deepgram Aura API
        const response = await fetch(`https://api.deepgram.com/v1/speak?model=${voice}`, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${DEEPGRAM_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[TTS] Deepgram error:', response.status, errorText);
            return new Response(JSON.stringify({ error: 'TTS generation failed', details: errorText }), {
                status: response.status,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Get audio as ArrayBuffer and convert to base64
        const audioBuffer = await response.arrayBuffer();
        const base64Audio = btoa(
            new Uint8Array(audioBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );

        console.log(`[TTS] Generated ${audioBuffer.byteLength} bytes of audio`);

        return new Response(JSON.stringify({
            audio: base64Audio,
            contentType: 'audio/mp3',
            voice,
            textLength: text.length
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error: any) {
        console.error('[TTS] Error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
