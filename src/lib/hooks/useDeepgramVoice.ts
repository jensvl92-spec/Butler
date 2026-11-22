/**
 * useDeepgramVoice - SOTA Speech-to-Text hook for Android/iOS & Web
 *
 * CRITICAL ANDROID SPEECHRECOGNIZER ENGINEERING:
 * 1. @capacitor-community/speech-recognition@6.0.1 never calls call.resolve() in Android stop(),
 *    so SpeechRecognition.stop() is ALWAYS bounded by raceTimeout(300ms) and state is released in finally.
 * 2. LAST-WORD PRESERVATION (Android RecognitionListener order):
 *    Android fires onEndOfSpeech() -> listeningState:'stopped' BEFORE decoding the final acoustic
 *    frames and delivering onResults() (~150-600ms later via 'partialResults').
 *    Previously, removing listeners immediately upon listeningState:'stopped' or silence timeout
 *    discarded onResults() and clipped the last word!
 *    Now:
 *    - On listeningState:'stopped', we enter `awaitingFinalResults` for up to 850ms so Android's
 *      final onResults() (with the complete last word & punctuation) ALWAYS lands first, then
 *      settles cleanly in 160ms.
 *    - On manual stop or 2.8s silence fallback, we call SpeechRecognition.stop() BEFORE removing
 *      listeners, allowing Android SpeechRecognizer.stopListening() to flush the final word into
 *      onResults() within a 550ms window before finalizing.
 *    - The silent-error watchdog never interrupts an active `awaitingFinalResults` window.
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
    const [isFinalizing, setIsFinalizing] = useState(false);
    const [partialTranscript, setPartialTranscript] = useState('');
    const [error, setError] = useState<string>('');
    const [isWhisper] = useState(false);
    const [audioLevel, setAudioLevel] = useState(0);

    const isListeningRef = useRef<boolean>(false);
    const isConnectingRef = useRef<boolean>(false);
    const awaitingFinalResultsRef = useRef<boolean>(false);
    const sessionIdRef = useRef<number>(0);
    const latestTranscriptRef = useRef<string>('');
    const hasEmittedFinalRef = useRef<boolean>(false);
    const isStoppingRef = useRef<boolean>(false);

    const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const noSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const finalResultsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        if (finalResultsTimerRef.current) {
            clearTimeout(finalResultsTimerRef.current);
            finalResultsTimerRef.current = null;
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

    // Hard finalization: tears down native/web listeners, releases UI state, and emits final transcript
    const finalizeAndCleanup = useCallback(async (reason = 'manual') => {
        if (isStoppingRef.current && reason !== 'cleanup') return;
        isStoppingRef.current = true;
        sessionIdRef.current += 1;
        awaitingFinalResultsRef.current = false;

        logger.info(`🎤 [Speech] Finalizing... (Reason: ${reason})`);
        clearTimers();

        const finalCandidate = latestTranscriptRef.current.trim();
        latestTranscriptRef.current = '';
        const shouldEmit = reason !== 'cleanup' && reason !== 'error' && reason !== 'cancel';

        isListeningRef.current = false;
        isConnectingRef.current = false;
        if (reason !== 'cleanup') {
            setIsListening(false);
            setIsConnecting(false);
            setIsFinalizing(false);
            setPartialTranscript('');
        }

        try {
            if (Capacitor.isNativePlatform()) {
                // Bounded with raceTimeout because @capacitor-community/speech-recognition@6.0.1
                // never resolves call in Android stop().
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

    // Soft stop: on Android, flushes the final buffered word via SpeechRecognition.stop()
    // while keeping listeners briefly alive to catch onResults() before tearing down!
    const stopListening = useCallback(async (reason = 'manual') => {
        if (reason === 'cleanup' || reason === 'error' || reason === 'cancel') {
            await finalizeAndCleanup(reason);
            return;
        }

        if (Capacitor.isNativePlatform() && isListeningRef.current && !awaitingFinalResultsRef.current) {
            const activeSessionId = sessionIdRef.current;
            awaitingFinalResultsRef.current = true;
            setIsFinalizing(true);

            // Clear speaking timers but KEEP listeners alive so Android's final onResults() can land!
            if (silenceTimerRef.current) {
                clearTimeout(silenceTimerRef.current);
                silenceTimerRef.current = null;
            }
            if (noSpeechTimerRef.current) {
                clearTimeout(noSpeechTimerRef.current);
                noSpeechTimerRef.current = null;
            }

            logger.info(`🎤 [Speech] Flushing Android recognizer for final word... (Reason: ${reason})`);
            // Fire-and-forget stop() so SpeechRecognizer.stopListening() flushes its last audio frame into onResults()
            SpeechRecognition.stop().catch(() => {});

            if (finalResultsTimerRef.current) clearTimeout(finalResultsTimerRef.current);
            finalResultsTimerRef.current = setTimeout(() => {
                if (sessionIdRef.current !== activeSessionId) return;
                finalizeAndCleanup(`${reason}_flush_timeout`);
            }, 600);
            return;
        }

        await finalizeAndCleanup(reason);
    }, [finalizeAndCleanup]);

    // Cleanup on unmount ONLY
    useEffect(() => {
        return () => {
            finalizeAndCleanup('cleanup');
        };
    }, [finalizeAndCleanup]);

    const resetSilenceTimer = useCallback((activeSessionId: number) => {
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
        }
        if (noSpeechTimerRef.current) {
            clearTimeout(noSpeechTimerRef.current);
            noSpeechTimerRef.current = null;
        }
        // Native Android has built-in end-of-speech VAD (onEndOfSpeech -> listeningState:'stopped').
        // Use a generous 2.8s silence fallback on native (1.8s on web) so natural pauses before the
        // last word are NEVER prematurely clipped!
        const silenceMs = Capacitor.isNativePlatform() ? 2800 : 1800;
        silenceTimerRef.current = setTimeout(() => {
            if (sessionIdRef.current !== activeSessionId || awaitingFinalResultsRef.current) return;
            if (latestTranscriptRef.current.trim()) {
                logger.info('🎤 [Speech] Silence fallback reached, flushing final results');
                stopListening('silence');
            }
        }, silenceMs);
    }, [stopListening]);

    const startListening = useCallback(async () => {
        if (isListeningRef.current || isConnectingRef.current || isStoppingRef.current) return;

        const currentSessionId = sessionIdRef.current + 1;
        sessionIdRef.current = currentSessionId;
        awaitingFinalResultsRef.current = false;

        isConnectingRef.current = true;
        setIsConnecting(true);
        setIsFinalizing(false);
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

                await raceTimeout(SpeechRecognition.removeAllListeners(), 250);
                if (sessionIdRef.current !== currentSessionId) return;

                await SpeechRecognition.addListener('partialResults', (data: { matches: string[] }) => {
                    if (sessionIdRef.current !== currentSessionId) return;
                    if (data.matches && data.matches.length > 0) {
                        const recognized = (data.matches[0] || '').trim();
                        if (!recognized) return;

                        latestTranscriptRef.current = recognized;
                        setPartialTranscript(recognized);
                        callbacksRef.current.onTranscript(recognized);

                        if (awaitingFinalResultsRef.current) {
                            // Android's onResults() just landed with the complete final sentence (including the last word)!
                            // Give a tiny 160ms settle window in case a trailing partial + final fired back-to-back.
                            logger.info('🎤 [Speech] Received post-stop final result:', recognized);
                            if (finalResultsTimerRef.current) clearTimeout(finalResultsTimerRef.current);
                            finalResultsTimerRef.current = setTimeout(() => {
                                if (sessionIdRef.current !== currentSessionId) return;
                                finalizeAndCleanup('native_final_result');
                            }, 160);
                        } else {
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
                        // CRITICAL: Android fires onEndOfSpeech (listeningState:'stopped') BEFORE onResults()!
                        // NEVER tear down listeners immediately here — wait up to 850ms for onResults()
                        // so the final spoken word is ALWAYS captured!
                        if (!awaitingFinalResultsRef.current) {
                            awaitingFinalResultsRef.current = true;
                            setIsFinalizing(true);
                            if (silenceTimerRef.current) {
                                clearTimeout(silenceTimerRef.current);
                                silenceTimerRef.current = null;
                            }
                            if (noSpeechTimerRef.current) {
                                clearTimeout(noSpeechTimerRef.current);
                                noSpeechTimerRef.current = null;
                            }
                            if (finalResultsTimerRef.current) clearTimeout(finalResultsTimerRef.current);
                            finalResultsTimerRef.current = setTimeout(() => {
                                if (sessionIdRef.current !== currentSessionId) return;
                                finalizeAndCleanup('native_stopped_grace');
                            }, 850);
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
                // NEVER interrupts an active `awaitingFinalResults` window!
                const startedAt = Date.now();
                nativeWatchdogRef.current = setInterval(async () => {
                    if (sessionIdRef.current !== currentSessionId) return;
                    if (awaitingFinalResultsRef.current) return;
                    if (Date.now() - startedAt < 2500) return;
                    try {
                        const status = await SpeechRecognition.isListening();
                        if (sessionIdRef.current !== currentSessionId || awaitingFinalResultsRef.current) return;
                        if (status && status.listening === false) {
                            logger.info('🎤 [Speech] Native watchdog detected recognizer stopped — entering grace window');
                            awaitingFinalResultsRef.current = true;
                            setIsFinalizing(true);
                            if (finalResultsTimerRef.current) clearTimeout(finalResultsTimerRef.current);
                            finalResultsTimerRef.current = setTimeout(() => {
                                if (sessionIdRef.current !== currentSessionId) return;
                                finalizeAndCleanup('native_watchdog');
                            }, 700);
                        }
                    } catch { }
                }, 950);

                // Absolute no-speech safety timeout (15s) so the mic can never spin indefinitely
                noSpeechTimerRef.current = setTimeout(() => {
                    if (sessionIdRef.current !== currentSessionId || awaitingFinalResultsRef.current) return;
                    logger.info('🎤 [Speech] No-speech timeout reached, stopping');
                    finalizeAndCleanup('no_speech_timeout');
                }, 15000);
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
                    finalizeAndCleanup('error');
                };

                recognition.onend = () => {
                    if (sessionIdRef.current !== currentSessionId) return;
                    finalizeAndCleanup('end');
                };

                recognition.start();
            }
        } catch (err: any) {
            logger.error('🎤 [Speech] Start failed:', err);
            setError(err?.message || 'Kon spraakherkenning niet starten');
            isConnectingRef.current = false;
            isListeningRef.current = false;
            awaitingFinalResultsRef.current = false;
            setIsConnecting(false);
            setIsListening(false);
            setIsFinalizing(false);
            clearTimers();
        }
    }, [clearTimers, effectiveLang, finalizeAndCleanup, resetSilenceTimer]);

    return {
        isListening,
        isStarting: isConnecting,
        isFinalizing,
        partialTranscript,
        error,
        isWhisper,
        audioLevel,
        startListening,
        stopListening
    };
}
