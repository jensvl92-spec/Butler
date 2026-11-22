import { PushNotifications, Token, ActionPerformed } from '@capacitor/push-notifications';
import { supabase } from '../lib/supabase';
import { Capacitor } from '@capacitor/core';
import { Toast } from '@capacitor/toast';

let actionHandler: ((actions: any[]) => Promise<void>) | null = null;
let suggestionsHandler: (() => Promise<void>) | null = null;
let activeConnectionIdRef: string | null = null;
let listenersInitialized = false;
let latestToken: string | null = null;

export const setActionListener = (handler: ((actions: any[]) => Promise<void>) | null) => {
    actionHandler = handler;
};

export const setSuggestionsListener = (handler: (() => Promise<void>) | null) => {
    suggestionsHandler = handler;
};

/**
 * Idempotent push registration: attaches native Capacitor listeners at most ONCE
 * (preventing N-times duplicate execution on connection switches) while updating
 * the active connection ID for FCM token persistence.
 */
export const registerPushNotifications = async (connectionId?: string) => {
    if (!Capacitor.isNativePlatform()) {
        return;
    }

    if (!connectionId) {
        activeConnectionIdRef = null;
        return;
    }

    activeConnectionIdRef = connectionId;

    // If we already have the FCM token from earlier in this session, just associate it with the new active connection
    if (latestToken) {
        await saveTokenToSupabase(latestToken, connectionId);
    }

    if (listenersInitialized) {
        return;
    }

    try {
        let permStatus = await PushNotifications.checkPermissions();

        if (permStatus.receive === 'prompt') {
            permStatus = await PushNotifications.requestPermissions();
        }

        if (permStatus.receive !== 'granted') {
            console.log('Push notification permission not granted');
            return;
        }

        // Remove any stale native listeners before attaching once
        await PushNotifications.removeAllListeners();

        await PushNotifications.addListener('registration', async (token: Token) => {
            latestToken = token.value;
            if (activeConnectionIdRef) {
                await saveTokenToSupabase(token.value, activeConnectionIdRef);
            }
        });

        await PushNotifications.addListener('registrationError', (error) => {
            console.error('❌ Push registration error:', error);
        });

        await PushNotifications.addListener('pushNotificationReceived', (notification) => {
            Toast.show({
                text: notification.title || 'Butler melding',
                duration: 'short'
            });
        });

        await PushNotifications.addListener('pushNotificationActionPerformed', async (notification: ActionPerformed) => {
            const data = notification.notification.data || {};

            // Handle suggestions, proactive habits, and daily briefings
            if (
                data.type === 'suggestions' ||
                data.category === 'PROACTIVE_HABIT' ||
                data.category === 'PLAN_REQUEST'
            ) {
                if (suggestionsHandler) {
                    await suggestionsHandler();
                }
                return;
            }

            if ((data.actionId === 'EXECUTE_ACTION' || data.type === 'execute_action') && data.payload && actionHandler) {
                try {
                    const payload = typeof data.payload === 'string'
                        ? JSON.parse(data.payload)
                        : data.payload;
                    const actionsToExecute = Array.isArray(payload)
                        ? payload
                        : (Array.isArray(payload?.actions) ? payload.actions : [payload]);
                    await actionHandler(actionsToExecute);
                } catch (e) {
                    console.error('Failed to execute notification action:', e);
                }
            }
        });

        listenersInitialized = true;

        try {
            await PushNotifications.register();
        } catch (regError) {
            console.error('❌ Failed during PushNotifications.register():', regError);
        }

        console.log('✅ Push notifications registered (singleton listeners)');
    } catch (error) {
        console.error('Failed to register push notifications:', error);
    }
};

export const clearPushTokenForConnection = async (connectionId?: string) => {
    if (!connectionId) return;
    try {
        await supabase
            .from('ha_connections')
            .update({ fcm_token: null })
            .eq('id', connectionId);
    } catch { }
};

const saveTokenToSupabase = async (token: string, connectionId: string) => {
    try {
        const { error } = await supabase
            .from('ha_connections')
            .update({ fcm_token: token })
            .eq('id', connectionId);

        if (error) {
            console.error('Failed to save FCM token:', error);
        }
    } catch (e) {
        console.error('Error saving FCM token:', e);
    }
};
