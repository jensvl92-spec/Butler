// import { PushNotifications } from '@capacitor/push-notifications';
import { supabase } from '../lib/supabase';
// import { Device } from '@capacitor/device';
import { Capacitor } from '@capacitor/core';
import { Toast } from '@capacitor/toast';


let actionHandler: ((actions: any[]) => Promise<void>) | null = null;

export const setActionListener = (handler: (actions: any[]) => Promise<void>) => {
    console.log("🔔 Push Action Listener Registered (STUB)");
    actionHandler = handler;
};

export const registerPushNotifications = async (connectionId?: string) => {
    console.log("Push notifications disabled for debug build.");
    return;
};

const saveTokenToSupabase = async (token: string, connectionId: string) => {
    // Stub
}
