/**
 * useDeepgramVoice - High reliability Speech-to-Text hook
 * 
 * Uses @capacitor-community/speech-recognition on Android/iOS native platforms
 * with on-device / Google Speech Recognition engine for zero-latency, reliable Dutch STT.
 * Falls back to Web Speech API on browser/web environments.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { logger } from '../../utils/logger';

interface UseDeepgramVoiceProps {
    onTranscript: (text: string) => void;
    onFinalTranscript: (text: string) => void;
}

export function useDeepgramVoice({ onTranscript, onFinalTranscript }: UseDeepgramVoiceProps) {
    const [isListening, setIsListening] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [partialTranscript, setPartialTranscript] = useState('');
    const [error, setError] = useState<string>('');
    const [isWhisper] = useState(false);
    const [audioLevel, setAudioLevel] = useState(0);

    const latestTranscriptRef = useRef<string>('');
    const silenceTimerRef = useRef<any>(null);
    const webRecognitionRef = useRef<any>(null);
    const callbacksRef = useRef({ onTranscript, onFinalTranscript });
    const audioLevelIntervalRef = useRef<any>(null);

    // Keep callbacks ref updated
    useEffect(() => {
        callbacksRef.current = { onTranscript, onFinalTranscript };
    }, [onTranscript, onFinalTranscript]);

    // Check permission on mount
    useEffect(() => {
        const checkPerms = async () => {
            try {
                if (Capacitor.isNativePlatform()) {
                    const status = await SpeechRecognition.checkPermissions();
                    if (status.speechRecognition !== 'granted') {
                        await SpeechRecognition.requestPermissions();
                    }
                }
            } catch (e) {
                logger.warn('🎤 [Speech] Permission check error:', e);
            }
        };
        checkPerms();

        return () => {
            stopListening('cleanup');
        };
    }, []);

    const stopListening = useCallback(async (reason = 'manual') => {
        logger.info(`🎤 [Speech] Stopping... (Reason: ${reason})`);

        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }

        if (audioLevelIntervalRef.current) {
            clearInterval(audioLevelIntervalRef.current);
            audioLevelIntervalRef.current = null;
        }
        setAudioLevel(0);

        const finalCandidate = latestTranscriptRef.current.trim();

        if (Capacitor.isNativePlatform()) {
            try {
                await SpeechRecognition.stop();
                await SpeechRecognition.removeAllListeners();
            } catch (e) {
                logger.warn('🎤 [Speech] Native stop error (ignorable):', e);
            }
        } else if (webRecognitionRef.current) {
            try {
                webRecognitionRef.current.stop();
            } catch (e) {
                // Ignore
            }
            webRecognitionRef.current = null;
        }

        setIsListening(false);
        setIsConnecting(false);

        // If we have a recognized transcript, trigger final callback
        if (finalCandidate) {
            logger.info('🎤 [Speech] Emitting final transcript:', finalCandidate);
            latestTranscriptRef.current = '';
            callbacksRef.current.onFinalTranscript(finalCandidate);
            setPartialTranscript('');
        }
    }, []);

    const resetSilenceTimer = useCallback(() => {
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
        }
        // Auto-finalize 1.8 seconds after user stops speaking
        silenceTimerRef.current = setTimeout(() => {
            if (latestTranscriptRef.current.trim()) {
                logger.info('🎤 [Speech] Silence timeout reached, finalizing');
                stopListening('silence');
            }
        }, 1800);
    }, [stopListening]);

    const startListening = useCallback(async () => {
        if (isListening || isConnecting) return;

        setIsConnecting(true);
        setError('');
        setPartialTranscript('');
        latestTranscriptRef.current = '';
        callbacksRef.current.onTranscript('');

        // Visual audio level pulse while active
        if (audioLevelIntervalRef.current) clearInterval(audioLevelIntervalRef.current);
        audioLevelIntervalRef.current = setInterval(() => {
            setAudioLevel(Math.floor(25 + Math.random() * 45));
        }, 150);

        try {
            if (Capacitor.isNativePlatform()) {
                logger.info('🎤 [Speech] Initializing native speech recognition...');

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
                        // Check if we need to emit final
                        if (latestTranscriptRef.current.trim()) {
                            const final = latestTranscriptRef.current.trim();
                            latestTranscriptRef.current = '';
                            callbacksRef.current.onFinalTranscript(final);
                            setPartialTranscript('');
                        }
                        setIsListening(false);
                        setIsConnecting(false);
                    }
                });

                await SpeechRecognition.start({
                    language: 'nl-NL',
                    maxResults: 1,
                    prompt: 'Spreek je vraag in...',
                    popup: false,
                    partialResults: true
                });

                setIsConnecting(false);
                setIsListening(true);
                logger.info('🎤 [Speech] Native speech recognition started');

            } else {
                // Web Speech API fallback for browser development/preview
                logger.info('🎤 [Speech] Falling back to Web Speech API');
                const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

                if (!SpeechRecognitionClass) {
                    throw new Error('Web Speech API wordt niet ondersteund in deze browser.');
                }

                const recognition = new SpeechRecognitionClass();
                webRecognitionRef.current = recognition;
                recognition.continuous = false;
                recognition.interimResults = true;
                recognition.lang = 'nl-NL';

                recognition.onstart = () => {
                    logger.info('🎤 [WebSpeech] Started');
                    setIsConnecting(false);
                    setIsListening(true);
                };

                recognition.onresult = (event: any) => {
                    let interim = '';
                    let final = '';

                    for (let i = event.resultIndex; i < event.results.length; ++i) {
                        const transcript = event.results[i][0].transcript;
                        if (event.results[i].isFinal) {
                            final += transcript;
                        } else {
                            interim += transcript;
                        }
                    }

                    const current = (final || interim).trim();
                    if (current) {
                        latestTranscriptRef.current = current;
                        setPartialTranscript(current);
                        callbacksRef.current.onTranscript(current);
                        resetSilenceTimer();
                    }
                };

                recognition.onerror = (event: any) => {
                    logger.warn('🎤 [WebSpeech] Error:', event.error);
                    if (event.error !== 'no-speech') {
                        setError(`Spraakfout: ${event.error}`);
                    }
                    stopListening('error');
                };

                recognition.onend = () => {
                    logger.info('🎤 [WebSpeech] Ended');
                    stopListening('end');
                };

                recognition.start();
            }

        } catch (err: any) {
            logger.error('🎤 [Speech] Start failed:', err);
            setError(err.message || 'Kon spraakherkenning niet starten');
            setIsConnecting(false);
            setIsListening(false);
            if (audioLevelIntervalRef.current) {
                clearInterval(audioLevelIntervalRef.current);
                audioLevelIntervalRef.current = null;
            }
            setAudioLevel(0);
        }
    }, [isListening, isConnecting, stopListening, resetSilenceTimer]);

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
