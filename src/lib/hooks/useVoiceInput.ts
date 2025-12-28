import { useState, useRef, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { Device } from '@capacitor/device';

interface UseVoiceInputProps {
    onTranscript: (text: string) => void;
    onFinalTranscript: (text: string) => void;
}

export function useVoiceInput({ onTranscript, onFinalTranscript }: UseVoiceInputProps) {
    const [isListening, setIsListening] = useState(false);
    const [partialTranscript, setPartialTranscript] = useState('');
    const [error, setError] = useState<string>('');

    const [isStarting, setIsStarting] = useState(false);

    // Refs
    const recognitionRef = useRef<any>(null);
    const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
    const lastStopRef = useRef<number>(0);
    const isListeningRef = useRef(false); // Track real native state
    const isStartingRef = useRef(false); // Track startup lock

    // Refs for callbacks to avoid effect re-runs (Stabilization Pattern)
    const callbacksRef = useRef({ onTranscript, onFinalTranscript });

    // Update refs on every render
    useEffect(() => {
        callbacksRef.current = { onTranscript, onFinalTranscript };
    }, [onTranscript, onFinalTranscript]);

    const stopListening = useCallback(async () => {
        import('../../utils/logger').then(({ logger }) => logger.info("🎤 Stop Listening Requested"));
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        lastStopRef.current = Date.now();

        if (Capacitor.isNativePlatform()) {
            // Cancel any pending start
            if (isStartingRef.current) {
                import('../../utils/logger').then(({ logger }) => logger.info("🎤 Stop called while starting, aborting start."));
                isStartingRef.current = false;
                setIsStarting(false);
            }

            if (isListeningRef.current) {
                try {
                    // TIMEOUT GUARD: Don't let a hanging plugin freeze the UI.
                    const stopP = SpeechRecognition.stop();
                    const timeoutP = new Promise(r => setTimeout(r, 500));
                    await Promise.race([stopP, timeoutP]);

                    // DO NOT remove listeners here. It causes a race condition where we might
                    // wipe out listeners attached by a concurrently starting session.
                    // Listeners are cleared at the START of the next session anyway.
                    // SpeechRecognition.removeAllListeners();
                } catch (e) {
                    import('../../utils/logger').then(({ logger }) => logger.warn("🎤 Stop Error", e));
                }
            } else {
                import('../../utils/logger').then(({ logger }) => logger.info("🎤 Already stopped (skipping native stop)"));
                // Same here - don't wipe listeners blindly
                // SpeechRecognition.removeAllListeners();
            }
        } else {
            recognitionRef.current?.stop();
        }
        // ALWAYS reset UI state locally, do not trust the plugin event to fire.
        // This fixes the "Stuck Red Button" issue where stop() is called but state remains true.
        setIsListening(false);
        isListeningRef.current = false;
    }, []);

    const startListening = useCallback(async () => {
        // Prevent double-start
        if (isStartingRef.current || isListeningRef.current) {
            import('../../utils/logger').then(({ logger }) => logger.warn("🎤 Start ignored: Already starting or listening"));
            return;
        }

        isStartingRef.current = true;
        setIsStarting(true);

        // Safety Watchdog: If native plugin hangs, unlock after 5s
        setTimeout(() => {
            if (isStartingRef.current) {
                import('../../utils/logger').then(({ logger }) => logger.warn("🎤 Watchdog: Forced Unlock of Startup Lock"));
                setIsStarting(false);
                isStartingRef.current = false;
            }
        }, 5000);

        setPartialTranscript('');
        callbacksRef.current.onTranscript('');
        setError('');

        // Safety Cooldown
        if (Date.now() - lastStopRef.current < 500) {
            await new Promise(r => setTimeout(r, 500));
        }

        if (Capacitor.isNativePlatform()) {
            try {
                // FORCE RESET: Stop any lingering native session (Timeout guarded)
                // This fixes "Double Tap" where the engine is secretly still running
                try {
                    const stopP = SpeechRecognition.stop();
                    const timeoutP = new Promise(r => setTimeout(r, 500));
                    await Promise.race([stopP, timeoutP]);
                } catch (e) { /* ignore */ }

                // Ensure clean slate
                await SpeechRecognition.removeAllListeners();

                // Double check we didn't stop while waiting
                if (!isStartingRef.current) return;

                const { available } = await SpeechRecognition.available();
                if (available) {
                    // Check before Request to save time
                    const p = await SpeechRecognition.checkPermissions();
                    if (p.speechRecognition !== 'granted') {
                        await SpeechRecognition.requestPermissions();
                        import('../../utils/logger').then(({ logger }) => logger.info("🎤 Native Speech: Permissions Requested & Granted"));
                    } else {
                        import('../../utils/logger').then(({ logger }) => logger.info("🎤 Native Speech: Permissions Already Granted"));
                    }

                    if (!isStartingRef.current) return; // Abort if stopped

                    // Setup Listeners JIT (Just-In-Time) - Session Based
                    await SpeechRecognition.addListener('partialResults', (data: any) => {
                        if (data.matches && data.matches.length > 0) {
                            const t = data.matches[0];
                            import('../../utils/logger').then(({ logger }) => logger.info(`🎤 Native Partial: ${t}`));
                            setPartialTranscript(t);
                            callbacksRef.current.onTranscript(t);

                            if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
                            silenceTimerRef.current = setTimeout(() => {
                                import('../../utils/logger').then(({ logger }) => logger.info("🎤 Native Auto-Submitting & Stopping"));
                                stopListening();
                                callbacksRef.current.onFinalTranscript(t);
                            }, 1200);
                        }
                    });

                    await SpeechRecognition.addListener('listeningState', (data: { status: string }) => {
                        const started = data.status === 'started';
                        import('../../utils/logger').then(({ logger }) => logger.info(`🎤 State Change: ${data.status}`));
                        setIsListening(started);
                        isListeningRef.current = started;
                        // If started, we are no longer "starting"
                        if (started) {
                            setIsStarting(false);
                            isStartingRef.current = false;
                        }
                    });

                    const result = await Device.getLanguageTag();
                    const langCode = result.value || 'en-US';
                    import('../../utils/logger').then(({ logger }) => logger.info(`🎤 Native Speech: Starting [${langCode}]`));

                    await SpeechRecognition.start({
                        partialResults: true,
                        popup: false,
                        language: langCode
                    });

                    // Trust the promise resolution. checking "started" event is good for status, 
                    // but we shouldn't block the UI lock on it if the plugin is lazy.
                    import('../../utils/logger').then(({ logger }) => logger.info("🎤 Native Start Promise Resolved"));
                    setIsStarting(false);
                    isStartingRef.current = false;

                } else {
                    import('../../utils/logger').then(({ logger }) => logger.warn("🎤 Native Speech: Not Available"));
                    setIsStarting(false);
                    isStartingRef.current = false;
                }
            } catch (e: any) {
                console.error("Native Speech Error", e);
                import('../../utils/logger').then(({ logger }) => logger.error("Native Speech Error", e));
                setError(e.message);
                setIsListening(false);
                isListeningRef.current = false;
                setIsStarting(false);
                isStartingRef.current = false;
                SpeechRecognition.removeAllListeners();
            }
        } else {
            // Web Speech API
            const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
            if (SpeechRecognition) {
                recognitionRef.current = new SpeechRecognition();
                recognitionRef.current.continuous = true;
                recognitionRef.current.interimResults = true;
                recognitionRef.current.lang = navigator.language || 'en-US';

                recognitionRef.current.onresult = (event: any) => {
                    let finalT = '';
                    let interimT = '';
                    for (let i = event.resultIndex; i < event.results.length; i++) {
                        const t = event.results[i][0].transcript;
                        if (event.results[i].isFinal) finalT += t;
                        else interimT += t;
                    }

                    const full = finalT + interimT;
                    if (full) {
                        import('../../utils/logger').then(({ logger }) => logger.info(`🎤 Web Speech: Transcript [${full}] (Uncertainty: ${event.results?.[event.resultIndex]?.confidence})`));
                        callbacksRef.current.onTranscript(full);
                        setPartialTranscript(interimT); // Visual feedback

                        // Auto-Submit Timer
                        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
                        silenceTimerRef.current = setTimeout(() => {
                            import('../../utils/logger').then(({ logger }) => logger.info("🎤 Web Speech: Auto-Submitting & Stopping"));
                            recognitionRef.current?.stop();
                            setIsListening(false);
                            isListeningRef.current = false;
                            callbacksRef.current.onFinalTranscript(full);
                        }, 1200);
                    }
                };

                recognitionRef.current.onerror = (e: any) => {
                    if (e.error !== 'no-speech') {
                        import('../../utils/logger').then(({ logger }) => logger.warn("Web Speech Error", e));
                        setIsListening(false);
                        isListeningRef.current = false;
                    }
                };

                recognitionRef.current.onend = () => {
                    setIsListening(false);
                    isListeningRef.current = false;
                };

                try {
                    recognitionRef.current.start();
                    setIsListening(true);
                    isListeningRef.current = true;
                } catch (e) {
                    console.warn("Web Speech Start Failed", e);
                }
            }
            setIsStarting(false);
            isStartingRef.current = false;
        }
    }, [stopListening]);

    // Unmount Cleanup
    useEffect(() => {
        return () => {
            if (Capacitor.isNativePlatform()) {
                SpeechRecognition.removeAllListeners();
            } else {
                recognitionRef.current?.stop();
            }
        };
    }, []);

    return { isListening, isStarting, partialTranscript, error, startListening, stopListening };
}
