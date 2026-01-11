/**
 * useDeepgramVoice - Real-time Speech-to-Text using Deepgram Nova-3
 *
 * Uses WebSocket streaming for low-latency, high-accuracy transcription.
 * Connects through Supabase Edge Function proxy to keep API key secure.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { logger } from '../../utils/logger';
// Supabase Edge Function URL for Deepgram proxy
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://rbriqijzyptjwsjrsqvc.supabase.co';
const DEEPGRAM_WS_URL = SUPABASE_URL.replace('https://', 'wss://') + '/functions/v1/deepgram-stt';
export function useDeepgramVoice({ onTranscript, onFinalTranscript }) {
    const [isListening, setIsListening] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [partialTranscript, setPartialTranscript] = useState('');
    const [error, setError] = useState('');
    const [isWhisper, setIsWhisper] = useState(false); // Whisper mode detection
    const [audioLevel, setAudioLevel] = useState(0); // 0-100 audio level
    // Refs
    const wsRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const streamRef = useRef(null);
    const audioContextRef = useRef(null);
    const processorRef = useRef(null);
    const audioBufferRef = useRef([]); // Buffer for audio before WS is ready
    const silenceTimerRef = useRef(null);
    const currentTranscriptRef = useRef('');
    const callbacksRef = useRef({ onTranscript, onFinalTranscript });
    const audioLevelsRef = useRef([]); // Track audio levels for whisper detection
    const WHISPER_THRESHOLD = 10; // Lowered from 25 to make normal speech less likely to trigger whisper
    // Keep callbacks ref updated
    useEffect(() => {
        callbacksRef.current = { onTranscript, onFinalTranscript };
    }, [onTranscript, onFinalTranscript]);
    // Pre-warm microphone on mount
    useEffect(() => {
        logger.info('🎤 [Deepgram] Pre-warming microphone...');
        preWarmMicrophone();
        return () => {
            // Cleanup on unmount will be handled by the cleanup effect below
        };
    }, []);
    const preWarmMicrophone = async () => {
        if (streamRef.current)
            return;
        try {
            // Check permissions first
            if (Capacitor.isNativePlatform()) {
                const status = await SpeechRecognition.checkPermissions();
                if (status.speechRecognition !== 'granted') {
                    await SpeechRecognition.requestPermissions();
                }
            }
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    echoCancellation: false, // Critical for speed
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            logger.info('🎤 [Deepgram] Microphone pre-warmed and ready');
            streamRef.current = stream;
        }
        catch (e) {
            logger.error('🎤 [Deepgram] Pre-warm failed:', e);
        }
    };
    const stopListening = useCallback(async (reason = 'manual') => {
        logger.info(`🎤 [Deepgram] Stopping... (Reason: ${reason})`);
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
        // Stop media recorder
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
        mediaRecorderRef.current = null;
        // Stop audio processor
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }
        // Close audio context (release resources)
        if (audioContextRef.current?.state !== 'closed') {
            await audioContextRef.current?.close();
        }
        audioContextRef.current = null;
        // Close WebSocket
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'close' }));
            wsRef.current.close();
        }
        wsRef.current = null;
        // ONLY stop the stream if we are unmounting ('cleanup')
        // Otherwise keep it open for instant restart (Pre-warming)
        if (reason === 'cleanup') {
            if (streamRef.current) {
                logger.info('🎤 [Deepgram] releasing microphone stream');
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }
        }
        setIsListening(false);
        setIsConnecting(false);
    }, []);
    const startListening = useCallback(async () => {
        if (isListening || isConnecting)
            return;
        setIsConnecting(true);
        setError('');
        setPartialTranscript('');
        currentTranscriptRef.current = ''; // Clear accumulated text
        callbacksRef.current.onTranscript('');
        audioBufferRef.current = [];
        try {
            // Re-use pre-warmed stream if available
            let stream = streamRef.current;
            if (!stream || !stream.active) {
                logger.warn('🎤 [Deepgram] Stream not ready, initializing now (latency penalty)...');
                await preWarmMicrophone();
                stream = streamRef.current;
                if (!stream) {
                    throw new Error('Microphone initialization failed');
                }
            }
            // Start capturing immediately (0ms latency if pre-warmed)
            const audioConfig = startAudioCapture(stream);
            // ... (rest of connection logic)
            // Get device language
            let language = 'multi';
            try {
                const result = await Device.getLanguageTag();
                language = result.value || 'multi';
            }
            catch { }
            let wsUrl = `${DEEPGRAM_WS_URL}?language=${encodeURIComponent(language)}`;
            if (audioConfig.encoding)
                wsUrl += `&encoding=${audioConfig.encoding}`;
            if (audioConfig.sampleRate)
                wsUrl += `&sample_rate=${audioConfig.sampleRate}`;
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;
            ws.onopen = () => { logger.info('🎤 [Deepgram] WebSocket OPENED'); };
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'ready') {
                        logger.info('🎤 [Deepgram] Ready! Flushing buffer...');
                        setIsConnecting(false);
                        setIsListening(true);
                        if (audioBufferRef.current.length > 0) {
                            audioBufferRef.current.forEach(chunk => ws.send(chunk));
                            audioBufferRef.current = [];
                        }
                    }
                    else if (data.type === 'transcript' && data.transcript) {
                        // Accumulate final transcripts, show interim for current word
                        if (data.is_final) {
                            // Append final transcript to accumulated text
                            const accumulated = currentTranscriptRef.current.trim();
                            if (accumulated) {
                                currentTranscriptRef.current = accumulated + ' ' + data.transcript.trim();
                            }
                            else {
                                currentTranscriptRef.current = data.transcript.trim();
                            }
                        }
                        // Display: accumulated finals + current interim
                        const displayText = data.is_final
                            ? currentTranscriptRef.current
                            : (currentTranscriptRef.current.trim() + ' ' + data.transcript).trim();
                        setPartialTranscript(displayText);
                        callbacksRef.current.onTranscript(displayText);
                        if (silenceTimerRef.current)
                            clearTimeout(silenceTimerRef.current);
                        silenceTimerRef.current = setTimeout(() => {
                            if (currentTranscriptRef.current.trim()) {
                                callbacksRef.current.onFinalTranscript(currentTranscriptRef.current);
                                stopListening();
                            }
                        }, 1500);
                    }
                    else if (data.type === 'utterance_end') {
                        if (currentTranscriptRef.current.trim()) {
                            callbacksRef.current.onFinalTranscript(currentTranscriptRef.current);
                            stopListening();
                        }
                    }
                }
                catch (e) {
                    logger.error('Parse error', e);
                }
            };
            ws.onerror = (e) => { setError('Connection Error'); stopListening(); };
            ws.onclose = () => { if (isListening)
                stopListening(); };
        }
        catch (e) {
            logger.error('🎤 [Deepgram] Start failed:', e);
            setError(e.message);
            setIsConnecting(false);
            stopListening();
        }
    }, [isListening, isConnecting, stopListening]);
    const startAudioCapture = (stream) => {
        try {
            // Use AudioContext for raw PCM data (better quality than MediaRecorder)
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            audioContextRef.current = audioContext;
            const source = audioContext.createMediaStreamSource(stream);
            // Create processor node (4096 samples per chunk)
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;
            processor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                // Convert Float32Array to Int16Array (linear16)
                const int16Data = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                const buffer = int16Data.buffer;
                // Calculate audio level (RMS) for whisper detection
                let sum = 0;
                for (let i = 0; i < inputData.length; i++) {
                    sum += inputData[i] * inputData[i];
                }
                const rms = Math.sqrt(sum / inputData.length);
                const level = Math.min(100, Math.round(rms * 200)); // Scale to 0-100
                setAudioLevel(level);
                // Track levels for average calculation
                audioLevelsRef.current.push(level);
                if (audioLevelsRef.current.length > 20) {
                    audioLevelsRef.current.shift(); // Keep last 20 samples
                }
                // Determine if whispering (average level below threshold)
                const avgLevel = audioLevelsRef.current.reduce((a, b) => a + b, 0) / audioLevelsRef.current.length;
                setIsWhisper(avgLevel < WHISPER_THRESHOLD && avgLevel > 0);
                if (wsRef.current?.readyState === WebSocket.OPEN && !isConnecting) {
                    wsRef.current.send(buffer);
                }
                else {
                    // Buffer if connecting
                    audioBufferRef.current.push(buffer);
                }
            };
            source.connect(processor);
            processor.connect(audioContext.destination);
            logger.info(`🎤 [Deepgram] AudioContext capture started (${audioContext.sampleRate}Hz)`);
            return { sampleRate: audioContext.sampleRate, encoding: 'linear16' };
        }
        catch (e) {
            logger.error('🎤 [Deepgram] Audio capture error:', e);
            // Fallback to MediaRecorder if AudioContext fails
            return startMediaRecorderCapture(stream);
        }
    };
    const startMediaRecorderCapture = (stream) => {
        // Fallback using MediaRecorder (less optimal but works on more platforms)
        const mediaRecorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm;codecs=opus'
        });
        mediaRecorderRef.current = mediaRecorder;
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                event.data.arrayBuffer().then(buffer => {
                    if (wsRef.current?.readyState === WebSocket.OPEN && !isConnecting) {
                        wsRef.current.send(buffer);
                    }
                    else {
                        audioBufferRef.current.push(buffer);
                    }
                });
            }
        };
        mediaRecorder.start(250); // Send chunks every 250ms
        logger.info('🎤 [Deepgram] MediaRecorder capture started (fallback)');
        return { encoding: undefined }; // Let Deepgram auto-detect container format
    };
    // Cleanup on unmount
    useEffect(() => {
        return () => {
            logger.info('🎤 [Deepgram] Cleanup effect triggered - stopping');
            stopListening('cleanup');
        };
    }, [stopListening]);
    return {
        isListening,
        isStarting: isConnecting,
        partialTranscript,
        error,
        isWhisper, // NEW: true if user is whispering
        audioLevel, // NEW: current audio level 0-100
        startListening,
        stopListening
    };
}
