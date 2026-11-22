/**
 * Speech & Neural TTS Utilities for Butler AI
 *
 * - sanitizeTextForSpeech: Strips all Markdown formatting (**, *, #, `, links, tables, emojis)
 *   and expands units so TTS NEVER reads asterisks or symbols aloud.
 * - Gemini Neural TTS (gemini-3.8-flash-lite-tts -> gemini-3.8-flash-tts -> gemini-2.5-flash-preview-tts)
 *   with automatic PCM16 -> WAV conversion when needed.
 * - Deepgram Aura-2 Neural TTS for BOTH Dutch (aura-2-sander-nl / aura-2-beatrix-nl) and English.
 * - Smart Native Android/Web voice selection preferring high-quality neural/network voices.
 */

import { fetchWithTimeout } from './home-assistant';
import { logger } from './logger';

export type TTSProviderPreference = 'auto' | 'gemini' | 'deepgram' | 'native';

export interface TTSConfig {
    provider: TTSProviderPreference;
    geminiVoice: string;
    deepgramVoiceNl: string;
    deepgramVoiceEn: string;
    enabled: boolean;
}

export const GEMINI_TTS_VOICES = [
    { id: 'Orus', label: 'Orus — Kalm & Helder (Man, aanbevolen Butler)' },
    { id: 'Charon', label: 'Charon — Warm & Informatief (Man)' },
    { id: 'Kore', label: 'Kore — Helder & Professioneel (Vrouw)' },
    { id: 'Aoede', label: 'Aoede — Vriendelijk & Natuurlijk (Vrouw)' },
    { id: 'Puck', label: 'Puck — Energiek & Vlot (Man)' },
    { id: 'Leda', label: 'Leda — Zacht & Modern (Vrouw)' },
    { id: 'Algieba', label: 'Algieba — Diep & Rustig (Man)' },
    { id: 'Despina', label: 'Despina — Soepel & Warm (Vrouw)' }
] as const;

export const DEEPGRAM_TTS_VOICES_NL = [
    { id: 'aura-2-sander-nl', label: 'Sander — Kalm & Diep (Nederlands, Man)' },
    { id: 'aura-2-beatrix-nl', label: 'Beatrix — Warm & Vriendelijk (Nederlands, Vrouw)' },
    { id: 'aura-2-cornelia-nl', label: 'Cornelia — Helder (Nederlands, Vrouw)' }
] as const;

const GEMINI_TTS_MODELS = [
    'gemini-3.8-flash-lite-tts',
    'gemini-3.8-flash-tts',
    'gemini-2.5-flash-preview-tts'
];

export function getTTSConfig(): TTSConfig {
    try {
        const rawProvider = localStorage.getItem('butler.tts_provider') as TTSProviderPreference | null;
        const provider: TTSProviderPreference =
            rawProvider && ['auto', 'gemini', 'deepgram', 'native'].includes(rawProvider)
                ? rawProvider
                : 'auto';
        const geminiVoice = localStorage.getItem('butler.tts_gemini_voice') || 'Orus';
        const deepgramVoiceNl = localStorage.getItem('butler.tts_deepgram_voice_nl') || 'aura-2-sander-nl';
        const deepgramVoiceEn = localStorage.getItem('butler.tts_deepgram_voice_en') || 'aura-2-asteria-en';
        const enabledRaw = localStorage.getItem('butler.tts_enabled');
        const enabled = enabledRaw === null ? true : enabledRaw === 'true';
        return { provider, geminiVoice, deepgramVoiceNl, deepgramVoiceEn, enabled };
    } catch {
        return {
            provider: 'auto',
            geminiVoice: 'Orus',
            deepgramVoiceNl: 'aura-2-sander-nl',
            deepgramVoiceEn: 'aura-2-asteria-en',
            enabled: true
        };
    }
}

export function saveTTSConfig(partial: Partial<TTSConfig>) {
    try {
        if (partial.provider !== undefined) localStorage.setItem('butler.tts_provider', partial.provider);
        if (partial.geminiVoice !== undefined) localStorage.setItem('butler.tts_gemini_voice', partial.geminiVoice);
        if (partial.deepgramVoiceNl !== undefined) localStorage.setItem('butler.tts_deepgram_voice_nl', partial.deepgramVoiceNl);
        if (partial.deepgramVoiceEn !== undefined) localStorage.setItem('butler.tts_deepgram_voice_en', partial.deepgramVoiceEn);
        if (partial.enabled !== undefined) localStorage.setItem('butler.tts_enabled', String(partial.enabled));
    } catch { }
}

/**
 * Thoroughly cleans AI markdown responses into natural spoken text.
 * Prevents TTS from reading "*", "**", "#", "`", URLs, tables, or emojis aloud.
 */
export function sanitizeTextForSpeech(rawText: string, language = 'nl'): string {
    if (!rawText) return '';
    const isDutch = !language || language.toLowerCase().startsWith('nl');

    let text = String(rawText);

    // 1. Remove fenced code blocks (keep short natural notice or drop)
    text = text.replace(/```[\s\S]*?```/g, ' ');

    // 2. Convert markdown links [label](url) -> label, and strip bare URLs
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    text = text.replace(/https?:\/\/\S+/gi, '');

    // 3. Clean markdown table separator lines (|---|---|) and pipes
    text = text.replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, ' ');
    text = text.replace(/\|/g, ', ');

    // 4. Strip headings, blockquotes, horizontal rules
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    text = text.replace(/^\s*>\s?/gm, '');
    text = text.replace(/^\s*([-*_]){3,}\s*$/gm, ' ');

    // 5. Convert bullet & numbered list markers to clean sentence breaks
    text = text.replace(/^\s*[-*•+]\s+/gm, '');
    text = text.replace(/^\s*(\d+)\.\s+/gm, '$1. ');

    // 6. Strip inline markdown emphasis & code markers (never leave lone * or _ or ` or ~)
    text = text.replace(/`([^`]+)`/g, '$1');
    text = text.replace(/(\*{1,3}|_{1,3}|~~)(.*?)\1/g, '$2');
    // Catch any stray/unmatched markdown symbols (like lonely * or **)
    text = text.replace(/[*_`~]/g, '');

    // 7. Remove emojis and pictographic symbols so TTS doesn't describe them
    text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0E}\u{FE0F}\u{200D}]/gu, '');

    // 8. Expand common smart-home & energy units for natural pronunciation
    if (isDutch) {
        text = text
            .replace(/€\s*\/\s*kWh/gi, 'euro per kilowattuur')
            .replace(/€\s*\/\s*m[³3]/gi, 'euro per kubieke meter')
            .replace(/(\d+(?:[.,]\d+)?)\s*€/g, '$1 euro')
            .replace(/€\s*(\d+(?:[.,]\d+)?)/g, '$1 euro')
            .replace(/°\s*C\b/g, ' graden')
            .replace(/\bkm\/h\b/gi, 'kilometer per uur')
            .replace(/\bkWh\b/g, 'kilowattuur')
            .replace(/\bm³\b/g, 'kubieke meter')
            .replace(/\s*&\s*/g, ' en ')
            .replace(/→|->/g, ' naar ');
    } else {
        text = text
            .replace(/€\s*\/\s*kWh/gi, 'euros per kilowatt hour')
            .replace(/€\s*\/\s*m[³3]/gi, 'euros per cubic meter')
            .replace(/°\s*C\b/g, ' degrees Celsius')
            .replace(/\bkm\/h\b/gi, 'kilometers per hour')
            .replace(/→|->/g, ' to ');
    }

    // 9. Turn newlines into smooth pauses and collapse whitespace
    text = text
        .replace(/\r?\n+/g, '. ')
        .replace(/\.\s*\./g, '.')
        .replace(/,\s*,/g, ',')
        .replace(/:\s*\./g, '.')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return text;
}

/**
 * Wraps raw 16-bit little-endian PCM bytes into a standard playable RIFF WAV container.
 */
function pcm16ToWavBlob(pcmBytes: Uint8Array, sampleRate = 24000, numChannels = 1): Blob {
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmBytes.byteLength;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    new Uint8Array(buffer, 44).set(pcmBytes);
    return new Blob([buffer], { type: 'audio/wav' });
}

function base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

/**
 * Synthesizes natural studio-quality speech directly via Google Gemini TTS API
 * using the user's configured Google Gemini API key.
 */
export async function synthesizeGeminiTTS(
    spokenText: string,
    apiKey: string,
    voiceName = 'Orus',
    options?: { isWhisper?: boolean; language?: string }
): Promise<{ blob: Blob; modelUsed: string } | null> {
    if (!apiKey || !spokenText.trim()) return null;

    // Limit TTS length to avoid long waits on huge reports (keep first ~900 chars at sentence boundary)
    let textToSpeak = spokenText.trim();
    if (textToSpeak.length > 900) {
        const cut = textToSpeak.slice(0, 900);
        const lastPeriod = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
        textToSpeak = lastPeriod > 250 ? cut.slice(0, lastPeriod + 1) : cut;
    }

    const isDutch = !options?.language || options.language.toLowerCase().startsWith('nl');

    for (const model of GEMINI_TTS_MODELS) {
        try {
            const isV38 = model.startsWith('gemini-3.8');
            const part: Record<string, any> = { text: textToSpeak };

            // Gemini 3.8 TTS supports turn-level style metadata; 2.5 preview takes plain text
            if (isV38) {
                part.speechMetadata = {
                    style: options?.isWhisper
                        ? 'soft, quiet, gentle whisper'
                        : isDutch
                            ? 'warm, relaxed, natural conversational Dutch speech, as if a friendly human assistant is talking smoothly and casually in the living room'
                            : 'warm, relaxed, natural conversational speech, as if a friendly human assistant is talking smoothly and casually'
                };
            }

            const body = {
                contents: [{ role: 'user', parts: [part] }],
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: voiceName || 'Orus'
                            }
                        }
                    }
                }
            };

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            const res = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                },
                body: JSON.stringify(body)
            }, 14000);

            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                logger.warn(`[TTS] Gemini ${model} HTTP ${res.status}: ${errText.slice(0, 160)}`);
                if (res.status === 401 || res.status === 403) return null;
                continue;
            }

            const data = await res.json();
            const parts = data?.candidates?.[0]?.content?.parts || [];
            const audioPart = parts.find((p: any) => p?.inlineData?.data);
            if (!audioPart?.inlineData?.data) {
                logger.warn(`[TTS] Gemini ${model} returned no inlineData audio`);
                continue;
            }

            const mimeType: string = (audioPart.inlineData.mimeType || '').toLowerCase();
            const rawBytes = base64ToUint8Array(audioPart.inlineData.data);

            // Check if already a WAV / MP3 / OGG container (RIFF header = 0x52 0x49 0x46 0x46)
            const hasRiffHeader =
                rawBytes.length >= 4 &&
                rawBytes[0] === 0x52 &&
                rawBytes[1] === 0x49 &&
                rawBytes[2] === 0x46 &&
                rawBytes[3] === 0x46;

            let blob: Blob;
            if (hasRiffHeader || mimeType.includes('wav')) {
                blob = new Blob([rawBytes.buffer as ArrayBuffer], { type: 'audio/wav' });
            } else if (mimeType.includes('mp3') || mimeType.includes('mpeg')) {
                blob = new Blob([rawBytes.buffer as ArrayBuffer], { type: 'audio/mpeg' });
            } else if (mimeType.includes('ogg')) {
                blob = new Blob([rawBytes.buffer as ArrayBuffer], { type: 'audio/ogg' });
            } else {
                // Default raw PCM16 (audio/L16;codec=pcm;rate=24000)
                const rateMatch = mimeType.match(/rate=(\d+)/);
                const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
                blob = pcm16ToWavBlob(rawBytes, sampleRate, 1);
            }

            logger.info(`🔊 [TTS] Gemini neural audio ready via ${model} (${voiceName}, ${Math.round(blob.size / 1024)} KB)`);
            return { blob, modelUsed: model };
        } catch (err: any) {
            logger.warn(`[TTS] Gemini ${model} failed: ${err?.message || err}`);
        }
    }

    return null;
}

/**
 * Synthesizes natural neural speech via Supabase Deepgram Aura-2 Edge Function
 * (supports BOTH Dutch and English!).
 */
export async function synthesizeDeepgramTTS(
    spokenText: string,
    supabaseUrl: string,
    jwt: string,
    language = 'nl',
    customVoice?: string
): Promise<{ blob: Blob; voice: string } | null> {
    if (!supabaseUrl || !jwt || !spokenText.trim()) return null;

    try {
        const res = await fetchWithTimeout(`${supabaseUrl.replace(/\/+$/, '')}/functions/v1/deepgram-tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${jwt}`
            },
            body: JSON.stringify({
                text: spokenText.slice(0, 1500),
                language,
                ...(customVoice ? { voice: customVoice } : {})
            })
        }, 12000);

        if (!res.ok) {
            logger.warn(`[TTS] Deepgram edge function HTTP ${res.status}`);
            return null;
        }

        const { audio, contentType, voice } = await res.json();
        if (!audio) return null;

        const bytes = base64ToUint8Array(audio);
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: contentType || 'audio/mp3' });
        logger.info(`🔊 [TTS] Deepgram Aura-2 audio ready (${voice}, ${Math.round(blob.size / 1024)} KB)`);
        return { blob, voice: voice || customVoice || 'aura-2' };
    } catch (err: any) {
        logger.warn(`[TTS] Deepgram failed: ${err?.message || err}`);
        return null;
    }
}

/**
 * Picks the highest quality (neural/network/wavenet) voice index from Android/Web TTS voice list.
 */
export function selectBestNativeVoiceIndex(
    voices: Array<{ voiceURI?: string; name?: string; lang?: string; localService?: boolean }>,
    targetLocale: string
): number {
    if (!Array.isArray(voices) || voices.length === 0) return -1;

    const targetFull = targetLocale.toLowerCase().replace('_', '-');
    const targetPrefix = targetFull.split('-')[0];

    let bestIdx = -1;
    let bestScore = -1;

    voices.forEach((v, idx) => {
        const lang = (v.lang || '').toLowerCase().replace('_', '-');
        if (!lang.startsWith(targetPrefix)) return;

        const uri = `${v.voiceURI || ''} ${v.name || ''}`.toLowerCase();
        let score = 10;

        // Exact locale match (e.g. nl-be or nl-nl)
        if (lang === targetFull) score += 20;
        else if (targetPrefix === 'nl' && (lang === 'nl-be' || lang === 'nl-nl')) score += 12;

        // Strongly prefer Google Neural / Network / Wavenet voices over legacy local robotic voices
        if (uri.includes('neural') || uri.includes('wavenet') || uri.includes('studio')) score += 45;
        if (uri.includes('network')) score += 35;
        if (v.localService === false) score += 25;
        // Google Android high-quality Dutch voices often contain -x- (e.g. nl-nl-x-dma-network, nl-be-x-...)
        if (/-x-[a-z0-9]+-network/.test(uri)) score += 30;
        else if (/-x-[a-z0-9]+-local/.test(uri)) score += 15;

        // Penalize robotic legacy engines
        if (uri.includes('espeak') || uri.includes('pico') || uri.includes('compact')) score -= 30;

        if (score > bestScore) {
            bestScore = score;
            bestIdx = idx;
        }
    });

    return bestIdx;
}
