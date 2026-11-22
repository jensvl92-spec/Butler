/**
 * useDeepgramVoice - High reliability Speech-to-Text hook
 *
 * Uses @capacitor-community/speech-recognition on Android/iOS native platforms
 * and falls back to Web Speech API in browser environments.
 * Hardened against double-final emissions, unmount leaks, and 150ms timer leaks.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { logger } from '../../utils/logger';

interface UseDeepgramVoiceProps {
    onTranscript: (text: string) => void;
    onFinalTranscript: (text: string) => void;
    language?: string;
}

export function useDeepgramVoice({ onTranscript, onFinalTranscript, language }: UseDeepgramVoiceProps) {
    const [isListening, setIsListening] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [partialTranscript, setPartialTranscript] = useState('');
    const [error, setError] = useState<string>('');
    const [isWhisper] = useState(false);
    const [audioLevel, setAudioLevel] = useState(0);

    const latestTranscriptRef = useRef<string>('');
    const hasEmittedFinalRef = useRef<boolean>(false);
    const isStoppingRef = useRef<boolean>(false);
    const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const webRecognitionRef = useRef<any>(null);
    const callbacksRef = useRef({ onTranscript, onFinalTranscript });
    const audioLevelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const effectiveLang = language && language.toLowerCase().startsWith('en') ? 'en-US' : 'nl-NL';

    useEffect(() => {
        callbacksRef.current = { onTranscript, onFinalTranscript };
    }, [onTranscript, onFinalTranscript]);

    const clearTimers = useCallback(() => {
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
        if (audioLevelIntervalRef.current) {
            clearInterval(audioLevelIntervalRef.current);
            audioLevelIntervalRef.current = null;
        }
        setAudioLevel(0);
    }, []);

    const emitFinalOnce = useCallback((candidate: string) => {
        const trimmed = candidate.trim();
        if (!trimmed || hasEmittedFinalRef.current) return;
        hasEmittedFinalRef.current = true;
        latestTranscriptRef.current = '';
        setPartialTranscript('');
        logger.info('🎤 [Speech] Emitting final transcript:', trimmed);
        callbacksRef.current.onFinalTranscript(trimmed);
    }, []);

    const stopListening = useCallback(async (reason = 'manual') => {
        if (isStoppingRef.current && reason !== 'cleanup') return;
        isStoppingRef.current = true;

        logger.info(`🎤 [Speech] Stopping... (Reason: ${reason})`);
        clearTimers();

        // Capture & clear transcript BEFORE calling stop() so native/web stop callbacks cannot double-emit!
        const finalCandidate = latestTranscriptRef.current.trim();
        latestTranscriptRef.current = '';
        const shouldEmit = reason !== 'cleanup' && reason !== 'error' && reason !== 'cancel';

        if (Capacitor.isNativePlatform()) {
            try {
                await SpeechRecognition.removeAllListeners();
                await SpeechRecognition.stop();
            } catch { }
        } else if (webRecognitionRef.current) {
            const rec = webRecognitionRef.current;
            webRecognitionRef.current = null;
            rec.onresult = null;
            rec.onerror = null;
            rec.onend = null;
            try {
                rec.stop();
            } catch { }
        }

        if (reason !== 'cleanup') {
            setIsListening(false);
            setIsConnecting(false);
            setPartialTranscript('');
        }

        if (shouldEmit && finalCandidate) {
            emitFinalOnce(finalCandidate);
        }

        isStoppingRef.current = false;
    }, [clearTimers, emitFinalOnce]);

    // Cleanup on unmount ONLY (never emit transcripts on unmount, never spam permissions on mount)
    useEffect(() => {
        return () => {
            stopListening('cleanup');
        };
    }, [stopListening]);

    const resetSilenceTimer = useCallback(() => {
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
        }
        silenceTimerRef.current = setTimeout(() => {
            if (latestTranscriptRef.current.trim()) {
                logger.info('🎤 [Speech] Silence timeout reached, finalizing');
                stopListening('silence');
            }
        }, 1800);
    }, [stopListening]);

    const startListening = useCallback(async () => {
        if (isListening || isConnecting || isStoppingRef.current) return;

        setIsConnecting(true);
        setError('');
        setPartialTranscript('');
        latestTranscriptRef.current = '';
        hasEmittedFinalRef.current = false;
        callbacksRef.current.onTranscript('');

        clearTimers();
        audioLevelIntervalRef.current = setInterval(() => {
            setAudioLevel(Math.floor(25 + Math.random() * 45));
        }, 150);

        try {
            if (Capacitor.isNativePlatform()) {
                const perms = await SpeechRecognition.checkPermissions();
                if (perms.speechRecognition !== 'granted') {
                    const req = await SpeechRecognition.requestPermissions();
                    if (req.speechRecognition !== 'granted') {
                        throw new Error('Microfoontoegang niet verleend.');
                    }
                }

                const availableRes = await SpeechRecognition.available();
                if (!availableRes.available) {
                    throw new Error('Spraakherkenning is niet beschikbaar op dit apparaat.');
                }

                await SpeechRecognition.removeAllListeners();

                await SpeechRecognition.addListener('partialResults', (data: { matches: string[] }) => {
                    if (data.matches && data.matches.length > 0) {
                        const recognized = data.matches[0];
                        if (recognized && recognized.trim()) {
                            latestTranscriptRef.current = recognized;
                            setPartialTranscript(recognized);
                            callbacksRef.current.onTranscript(recognized);
                            resetSilenceTimer();
                        }
                    }
                });

                await SpeechRecognition.addListener('listeningState', (data: { status: 'started' | 'stopped' }) => {
                    logger.info(`🎤 [Speech] Native listeningState: ${data.status}`);
                    if (data.status === 'started') {
                        setIsConnecting(false);
                        setIsListening(true);
                    } else if (data.status === 'stopped') {
                        clearTimers();
                        const final = latestTranscriptRef.current.trim();
                        if (final) {
                            emitFinalOnce(final);
                        }
                        setIsListening(false);
                        setIsConnecting(false);
                        SpeechRecognition.removeAllListeners().catch(() => {});
                    }
                });

                await SpeechRecognition.start({
                    language: effectiveLang,
                    maxResults: 1,
                    prompt: effectiveLang.startsWith('nl') ? 'Spreek je vraag in...' : 'Speak your command...',
                    popup: false,
                    partialResults: true
                });

                setIsConnecting(false);
                setIsListening(true);
            } else {
                const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
                if (!SpeechRecognitionClass) {
                    throw new Error('Web Speech API wordt niet ondersteund in deze browser.');
                }

                const recognition = new SpeechRecognitionClass();
                webRecognitionRef.current = recognition;
                recognition.continuous = false;
                recognition.interimResults = true;
                recognition.lang = effectiveLang;

                recognition.onstart = () => {
                    setIsConnecting(false);
                    setIsListening(true);
                };

                recognition.onresult = (event: any) => {
                    let fullTranscript = '';
                    // Start from 0 so earlier segments in the utterance are never lost!
                    for (let i = 0; i < event.results.length; ++i) {
                        fullTranscript += event.results[i][0]?.transcript || '';
                    }

                    const current = fullTranscript.trim();
                    if (current) {
                        latestTranscriptRef.current = current;
                        setPartialTranscript(current);
                        callbacksRef.current.onTranscript(current);
                        resetSilenceTimer();
                    }
                };

                recognition.onerror = (event: any) => {
                    logger.warn('🎤 [WebSpeech] Error:', event.error);
                    if (event.error !== 'no-speech' && event.error !== 'aborted') {
                        setError(`Spraakfout: ${event.error}`);
                    }
                    stopListening('error');
                };

                recognition.onend = () => {
                    stopListening('end');
                };

                recognition.start();
            }
        } catch (err: any) {
            logger.error('🎤 [Speech] Start failed:', err);
            setError(err?.message || 'Kon spraakherkenning niet starten');
            setIsConnecting(false);
            setIsListening(false);
            clearTimers();
        }
    }, [isListening, isConnecting, clearTimers, emitFinalOnce, effectiveLang, stopListening, resetSilenceTimer]);

    return {
        isListening,
        isStarting: isConnecting,
        partialTranscript,
        error,
        isWhisper,
        audioLevel,
        startListening,
        stopListening
    };
}
