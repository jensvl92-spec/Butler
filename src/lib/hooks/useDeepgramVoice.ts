/**
 * useDeepgramVoice - High reliability Speech-to-Text hook
 *
 * Uses @capacitor-community/speech-recognition on Android/iOS native platforms
 * and falls back to Web Speech API in browser environments.
 *
 * CRITICAL ANDROID FIXES:
 * 1. @capacitor-community/speech-recognition@6.0.1 never calls call.resolve() in Android stop(),
 *    so awaiting SpeechRecognition.stop() previously hung FOREVER after the first utterance,
 *    locking isStoppingRef=true and isListening=true permanently.
 *    We now race stop()/removeAllListeners() against a 350ms timeout and always reset state in finally.
 * 2. Android SpeechRecognizer silently drops onError (ERROR_NO_MATCH / ERROR_SPEECH_TIMEOUT)
 *    without emitting listeningState='stopped' when partialResults=true. A native watchdog polls
 *    SpeechRecognition.isListening() and enforces a clean no-speech timeout so the mic never sticks.
 * 3. Session ID guards prevent stale callbacks/timers from interfering with subsequent taps.
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

function raceTimeout<T>(promise: Promise<T>, ms = 350): Promise<T | void> {
    return Promise.race([
        promise.catch(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, ms))
    ]);
}

export function useDeepgramVoice({ onTranscript, onFinalTranscript, language }: UseDeepgramVoiceProps) {
    const [isListening, setIsListening] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [partialTranscript, setPartialTranscript] = useState('');
    const [error, setError] = useState<string>('');
    const [isWhisper] = useState(false);
    const [audioLevel, setAudioLevel] = useState(0);

    const isListeningRef = useRef<boolean>(false);
    const isConnectingRef = useRef<boolean>(false);
    const sessionIdRef = useRef<number>(0);
    const latestTranscriptRef = useRef<string>('');
    const hasEmittedFinalRef = useRef<boolean>(false);
    const isStoppingRef = useRef<boolean>(false);

    const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const noSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stoppedGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const audioLevelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const webRecognitionRef = useRef<any>(null);
    const callbacksRef = useRef({ onTranscript, onFinalTranscript });

    const effectiveLang = language && language.toLowerCase().startsWith('en') ? 'en-US' : 'nl-NL';

    useEffect(() => {
        callbacksRef.current = { onTranscript, onFinalTranscript };
    }, [onTranscript, onFinalTranscript]);

    const clearTimers = useCallback(() => {
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
        if (noSpeechTimerRef.current) {
            clearTimeout(noSpeechTimerRef.current);
            noSpeechTimerRef.current = null;
        }
        if (stoppedGraceTimerRef.current) {
            clearTimeout(stoppedGraceTimerRef.current);
            stoppedGraceTimerRef.current = null;
        }
        if (nativeWatchdogRef.current) {
            clearInterval(nativeWatchdogRef.current);
            nativeWatchdogRef.current = null;
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
        sessionIdRef.current += 1;

        logger.info(`🎤 [Speech] Stopping... (Reason: ${reason})`);
        clearTimers();

        // Capture & clear transcript BEFORE invoking native/web stop so callbacks cannot double-emit
        const finalCandidate = latestTranscriptRef.current.trim();
        latestTranscriptRef.current = '';
        const shouldEmit = reason !== 'cleanup' && reason !== 'error' && reason !== 'cancel';

        // Immediately release UI state so the mic button NEVER appears stuck!
        isListeningRef.current = false;
        isConnectingRef.current = false;
        if (reason !== 'cleanup') {
            setIsListening(false);
            setIsConnecting(false);
            setPartialTranscript('');
        }

        try {
            if (Capacitor.isNativePlatform()) {
                // CRITICAL: SpeechRecognition.stop() in v6.0.1 Android Java NEVER calls call.resolve()!
                // Must be bounded with raceTimeout so stopListening ALWAYS completes cleanly.
                await raceTimeout(SpeechRecognition.removeAllListeners(), 250);
                await raceTimeout(SpeechRecognition.stop(), 300);
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
        } catch { }
        finally {
            isStoppingRef.current = false;
        }

        if (shouldEmit && finalCandidate) {
            emitFinalOnce(finalCandidate);
        }
    }, [clearTimers, emitFinalOnce]);

    // Cleanup on unmount ONLY
    useEffect(() => {
        return () => {
            stopListening('cleanup');
        };
    }, [stopListening]);

    const resetSilenceTimer = useCallback((activeSessionId: number) => {
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
        }
        if (noSpeechTimerRef.current) {
            clearTimeout(noSpeechTimerRef.current);
            noSpeechTimerRef.current = null;
        }
        silenceTimerRef.current = setTimeout(() => {
            if (sessionIdRef.current !== activeSessionId) return;
            if (latestTranscriptRef.current.trim()) {
                logger.info('🎤 [Speech] Silence timeout reached, finalizing');
                stopListening('silence');
            }
        }, 1600);
    }, [stopListening]);

    const startListening = useCallback(async () => {
        if (isListeningRef.current || isConnectingRef.current || isStoppingRef.current) return;

        const currentSessionId = sessionIdRef.current + 1;
        sessionIdRef.current = currentSessionId;

        isConnectingRef.current = true;
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
                if (sessionIdRef.current !== currentSessionId) return;

                if (perms.speechRecognition !== 'granted') {
                    const req = await SpeechRecognition.requestPermissions();
                    if (sessionIdRef.current !== currentSessionId) return;
                    if (req.speechRecognition !== 'granted') {
                        throw new Error('Microfoontoegang niet verleend.');
                    }
                }

                const availableRes = await SpeechRecognition.available();
                if (sessionIdRef.current !== currentSessionId) return;
                if (!availableRes.available) {
                    throw new Error('Spraakherkenning is niet beschikbaar op dit apparaat.');
                }

                // Cleanly ensure any leftover native session/listeners are cleared
                await raceTimeout(SpeechRecognition.removeAllListeners(), 250);
                if (sessionIdRef.current !== currentSessionId) return;

                await SpeechRecognition.addListener('partialResults', (data: { matches: string[] }) => {
                    if (sessionIdRef.current !== currentSessionId) return;
                    if (data.matches && data.matches.length > 0) {
                        const recognized = data.matches[0];
                        if (recognized && recognized.trim()) {
                            latestTranscriptRef.current = recognized;
                            setPartialTranscript(recognized);
                            callbacksRef.current.onTranscript(recognized);
                            resetSilenceTimer(currentSessionId);
                        }
                    }
                });

                await SpeechRecognition.addListener('listeningState', (data: { status: 'started' | 'stopped' }) => {
                    if (sessionIdRef.current !== currentSessionId) return;
                    logger.info(`🎤 [Speech] Native listeningState: ${data.status}`);
                    if (data.status === 'started') {
                        isConnectingRef.current = false;
                        isListeningRef.current = true;
                        setIsConnecting(false);
                        setIsListening(true);
                    } else if (data.status === 'stopped') {
                        // Android emits onEndOfSpeech BEFORE onResults; wait briefly if transcript isn't here yet
                        if (latestTranscriptRef.current.trim()) {
                            stopListening('native_stopped');
                        } else {
                            if (stoppedGraceTimerRef.current) clearTimeout(stoppedGraceTimerRef.current);
                            stoppedGraceTimerRef.current = setTimeout(() => {
                                if (sessionIdRef.current !== currentSessionId) return;
                                stopListening('native_stopped_grace');
                            }, 450);
                        }
                    }
                });

                await SpeechRecognition.start({
                    language: effectiveLang,
                    maxResults: 1,
                    prompt: effectiveLang.startsWith('nl') ? 'Spreek je vraag in...' : 'Speak your command...',
                    popup: false,
                    partialResults: true
                });

                if (sessionIdRef.current !== currentSessionId) return;

                isConnectingRef.current = false;
                isListeningRef.current = true;
                setIsConnecting(false);
                setIsListening(true);

                // Native Watchdog: detects silent Android ERROR_NO_MATCH / ERROR_SPEECH_TIMEOUT
                // where native recognizer stops without emitting listeningState='stopped'
                const startedAt = Date.now();
                nativeWatchdogRef.current = setInterval(async () => {
                    if (sessionIdRef.current !== currentSessionId) return;
                    if (Date.now() - startedAt < 2200) return;
                    try {
                        const status = await SpeechRecognition.isListening();
                        if (sessionIdRef.current !== currentSessionId) return;
                        if (status && status.listening === false) {
                            logger.info('🎤 [Speech] Native watchdog detected recognizer stopped silently — resetting');
                            stopListening('native_watchdog');
                        }
                    } catch { }
                }, 1000);

                // Absolute no-speech safety timeout (14s) so the mic can never spin indefinitely
                noSpeechTimerRef.current = setTimeout(() => {
                    if (sessionIdRef.current !== currentSessionId) return;
                    logger.info('🎤 [Speech] No-speech timeout reached, stopping');
                    stopListening('no_speech_timeout');
                }, 14000);
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
                    if (sessionIdRef.current !== currentSessionId) return;
                    isConnectingRef.current = false;
                    isListeningRef.current = true;
                    setIsConnecting(false);
                    setIsListening(true);
                };

                recognition.onresult = (event: any) => {
                    if (sessionIdRef.current !== currentSessionId) return;
                    let fullTranscript = '';
                    for (let i = 0; i < event.results.length; ++i) {
                        fullTranscript += event.results[i][0]?.transcript || '';
                    }

                    const current = fullTranscript.trim();
                    if (current) {
                        latestTranscriptRef.current = current;
                        setPartialTranscript(current);
                        callbacksRef.current.onTranscript(current);
                        resetSilenceTimer(currentSessionId);
                    }
                };

                recognition.onerror = (event: any) => {
                    if (sessionIdRef.current !== currentSessionId) return;
                    logger.warn('🎤 [WebSpeech] Error:', event.error);
                    if (event.error !== 'no-speech' && event.error !== 'aborted') {
                        setError(`Spraakfout: ${event.error}`);
                    }
                    stopListening('error');
                };

                recognition.onend = () => {
                    if (sessionIdRef.current !== currentSessionId) return;
                    stopListening('end');
                };

                recognition.start();
            }
        } catch (err: any) {
            logger.error('🎤 [Speech] Start failed:', err);
            setError(err?.message || 'Kon spraakherkenning niet starten');
            isConnectingRef.current = false;
            isListeningRef.current = false;
            setIsConnecting(false);
            setIsListening(false);
            clearTimers();
        }
    }, [clearTimers, effectiveLang, stopListening, resetSilenceTimer]);

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
