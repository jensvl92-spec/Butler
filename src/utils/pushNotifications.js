import { PushNotifications } from '@capacitor/push-notifications';
import { supabase } from '../lib/supabase';
import { Capacitor } from '@capacitor/core';
import { Toast } from '@capacitor/toast';
let actionHandler = null;
let suggestionsHandler = null;
export const setActionListener = (handler) => {
    console.log("🔔 Push Action Listener Registered");
    actionHandler = handler;
};
export const setSuggestionsListener = (handler) => {
    console.log("📋 Push Suggestions Listener Registered");
    suggestionsHandler = handler;
};
export const registerPushNotifications = async (connectionId) => {
    // Only run on native platforms
    if (!Capacitor.isNativePlatform()) {
        console.log("Push notifications not available on web");
        return;
    }
    if (!connectionId) {
        console.log("No connection ID provided for push notifications");
        return;
    }
    try {
        // Check/request permission
        let permStatus = await PushNotifications.checkPermissions();
        if (permStatus.receive === 'prompt') {
            permStatus = await PushNotifications.requestPermissions();
        }
        if (permStatus.receive !== 'granted') {
            console.log("Push notification permission not granted");
            return;
        }
        // Register for push notifications
        await PushNotifications.register();
        // Listen for registration success
        PushNotifications.addListener('registration', async (token) => {
            console.log('🔔 FCM Token received:', token.value.substring(0, 20) + '...');
            await saveTokenToSupabase(token.value, connectionId);
        });
        // Listen for registration errors
        PushNotifications.addListener('registrationError', (error) => {
            console.error('❌ Push registration error:', error);
        });
        // Listen for push notifications received while app is in foreground
        PushNotifications.addListener('pushNotificationReceived', (notification) => {
            console.log('📬 Push received (foreground):', notification.title);
            Toast.show({
                text: notification.title || 'New notification',
                duration: 'short'
            });
        });
        // Listen for notification taps (when user clicks notification)
        PushNotifications.addListener('pushNotificationActionPerformed', async (notification) => {
            console.log('👆 Notification tapped:', notification.notification.data);
            const data = notification.notification.data;
            // Handle suggestions notification - trigger suggestions view
            if (data?.type === 'suggestions') {
                console.log('📋 Suggestions notification tapped - triggering view');
                if (suggestionsHandler) {
                    await suggestionsHandler();
                }
                return;
            }
            // Handle custom actions from notification data
            if (data?.actionId === 'EXECUTE_ACTION' && data?.payload && actionHandler) {
                try {
                    const payload = typeof data.payload === 'string'
                        ? JSON.parse(data.payload)
                        : data.payload;
                    await actionHandler([payload]);
                }
                catch (e) {
                    console.error('Failed to execute notification action:', e);
                }
            }
        });
        console.log('✅ Push notifications registered');
    }
    catch (error) {
        console.error('Failed to register push notifications:', error);
    }
};
const saveTokenToSupabase = async (token, connectionId) => {
    try {
        const { error } = await supabase
            .from('ha_connections')
            .update({ fcm_token: token })
            .eq('id', connectionId);
        if (error) {
            console.error('Failed to save FCM token:', error);
        }
        else {
            console.log('✅ FCM token saved to Supabase');
        }
    }
    catch (e) {
        console.error('Error saving FCM token:', e);
    }
};
