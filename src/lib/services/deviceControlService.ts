import { Capacitor, registerPlugin } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { findContactByName } from '../../utils/contactsService';
import { logger } from '../../utils/logger';

interface DeviceControlPluginInterface {
    setFlashlight(opts: { mode: 'on' | 'off' | 'toggle' }): Promise<{ enabled: boolean; message: string }>;
    setVolume(opts: { stream?: string; percent?: number; direction?: string }): Promise<{ stream: string; percent: number }>;
    setRingerMode(opts: { mode: 'normal' | 'vibrate' | 'silent' }): Promise<{ mode: string; note?: string }>;
    dialNumber(opts: { phone: string }): Promise<{ opened: boolean; phone: string }>;
    openApp(opts: { app: string; query?: string }): Promise<{ opened: boolean; app: string }>;
    getBatteryStatus(): Promise<{ percent: number; isCharging: boolean }>;
    setKeepScreenOn(opts: { enabled: boolean }): Promise<{ enabled: boolean }>;
}

interface TimerPluginInterface {
    setTimer(opts: { seconds: number; message: string }): Promise<void>;
    setAlarm(opts: { hour: number; minute: number; message: string; days?: number[] }): Promise<void>;
}

const DeviceControlPlugin = registerPlugin<DeviceControlPluginInterface>('DeviceControlPlugin');
const TimerPlugin = registerPlugin<TimerPluginInterface>('TimerPlugin');

export async function setPhoneFlashlight(mode: 'on' | 'off' | 'toggle' = 'toggle') {
    if (!Capacitor.isNativePlatform()) {
        return { error: 'Zaklamp-bediening is alleen beschikbaar op de Android-app.' };
    }
    try {
        const res = await DeviceControlPlugin.setFlashlight({ mode });
        return { success: true, ...res };
    } catch (e: any) {
        logger.error('[DeviceControl] setFlashlight error:', e);
        return { error: e?.message || 'Kon de zaklamp niet schakelen.' };
    }
}

export async function setPhoneVolume(opts: { stream?: string; percent?: number; direction?: string }) {
    if (!Capacitor.isNativePlatform()) {
        return { error: 'Volumebediening van het toestel is alleen beschikbaar op Android.' };
    }
    try {
        const res = await DeviceControlPlugin.setVolume(opts);
        return { success: true, ...res };
    } catch (e: any) {
        return { error: e?.message || 'Kon het volume niet aanpassen.' };
    }
}

export async function setPhoneRingerMode(mode: 'normal' | 'vibrate' | 'silent') {
    if (!Capacitor.isNativePlatform()) {
        return { error: 'Geluidsmodus wijzigen is alleen beschikbaar op Android.' };
    }
    try {
        const res = await DeviceControlPlugin.setRingerMode({ mode });
        return { success: true, ...res };
    } catch (e: any) {
        return { error: e?.message || 'Kon de geluidsmodus niet aanpassen.' };
    }
}

export async function getPhoneBatteryStatus() {
    if (!Capacitor.isNativePlatform()) {
        try {
            const nav: any = navigator;
            if (typeof nav.getBattery === 'function') {
                const bat = await nav.getBattery();
                return { success: true, percent: Math.round(bat.level * 100), isCharging: !!bat.charging };
            }
        } catch { }
        return { error: 'Batterijstatus is niet beschikbaar in deze browser.' };
    }
    try {
        const res = await DeviceControlPlugin.getBatteryStatus();
        return { success: true, ...res };
    } catch (e: any) {
        return { error: e?.message || 'Kon batterijstatus niet ophalen.' };
    }
}

export async function setKeepScreenOn(enabled: boolean): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
        await DeviceControlPlugin.setKeepScreenOn({ enabled });
    } catch { }
}

export async function openPhoneApp(app: string, query?: string) {
    if (!Capacitor.isNativePlatform()) {
        if (app.toLowerCase() === 'youtube' && query) {
            window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
            return { success: true, opened: true, app: 'youtube' };
        }
        return { error: `App "${app}" openen is alleen beschikbaar op Android.` };
    }
    try {
        const res = await DeviceControlPlugin.openApp({ app, query });
        return { success: true, ...res };
    } catch (e: any) {
        return { error: e?.message || `Kon app "${app}" niet openen.` };
    }
}

export async function startNativeTimer(seconds: number, message: string) {
    if (!Capacitor.isNativePlatform()) {
        return { success: true, note: `Timer van ${Math.round(seconds / 60)} min (${message}) geregistreerd (webmodus).` };
    }
    try {
        await TimerPlugin.setTimer({ seconds: Math.max(1, Math.round(seconds)), message: message || 'Butler Timer' });
        return { success: true, seconds, message };
    } catch (e: any) {
        return { error: e?.message || 'Kon timer niet instellen.' };
    }
}

export async function startNativeAlarm(hour: number, minute: number, message: string, days?: number[]) {
    if (!Capacitor.isNativePlatform()) {
        return { success: true, note: `Wekker om ${hour}:${String(minute).padStart(2, '0')} geregistreerd (webmodus).` };
    }
    try {
        await TimerPlugin.setAlarm({ hour, minute, message: message || 'Butler Wekker', days });
        return { success: true, hour, minute, message };
    } catch (e: any) {
        return { error: e?.message || 'Kon wekker niet instellen.' };
    }
}

export async function openTurnByTurnNavigation(destination: string, mode: 'driving' | 'walking' | 'bicycling' = 'driving') {
    const cleanDest = (destination || '').trim();
    if (!cleanDest) return { error: 'Geen bestemming opgegeven.' };

    const modeCode = mode === 'walking' ? 'w' : mode === 'bicycling' ? 'b' : 'd';
    const navUrl = `google.navigation:q=${encodeURIComponent(cleanDest)}&mode=${modeCode}`;
    const webMaps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(cleanDest)}&travelmode=${mode}`;

    try {
        if (Capacitor.isNativePlatform()) {
            try {
                await Browser.open({ url: navUrl });
            } catch {
                await Browser.open({ url: webMaps });
            }
        } else {
            window.open(webMaps, '_blank', 'noopener,noreferrer');
        }
        return { success: true, destination: cleanDest, mode, maps_url: webMaps };
    } catch (e: any) {
        return { error: e?.message || 'Kon navigatie niet openen.', maps_url: webMaps };
    }
}

export async function openExternalUrl(url: string) {
    const clean = (url || '').trim();
    if (!clean) return { error: 'Geen URL opgegeven.' };
    try {
        if (Capacitor.isNativePlatform()) {
            await Browser.open({ url: clean });
        } else {
            window.open(clean, '_blank', 'noopener,noreferrer');
        }
        return { success: true, url: clean };
    } catch (e: any) {
        return { error: e?.message || 'Kon link niet openen.' };
    }
}

export async function communicateWithContact(opts: {
    channel: 'whatsapp' | 'sms' | 'call' | 'line';
    contact_name?: string;
    phone?: string;
    message?: string;
}) {
    const channel = opts.channel;
    const text = (opts.message || '').trim();
    let resolvedName = (opts.contact_name || '').trim();
    let finalPhone = (opts.phone || '').replace(/[^0-9+]/g, '');

    if (channel === 'line') {
        const lineUrl = `https://line.me/R/share?text=${encodeURIComponent(text)}`;
        try {
            if (Capacitor.isNativePlatform()) {
                await Browser.open({ url: lineUrl, presentationStyle: 'popover' });
            } else {
                window.open(lineUrl, '_blank', 'noopener,noreferrer');
            }
            return { success: true, channel: 'line', message: text };
        } catch (e: any) {
            return { error: e?.message || 'Kon Line niet openen.' };
        }
    }

    if (!finalPhone && resolvedName) {
        try {
            const contact = await findContactByName(resolvedName);
            if (contact?.phone) {
                finalPhone = contact.phone.replace(/[^0-9+]/g, '');
                resolvedName = contact.name || resolvedName;
            }
        } catch (e: any) {
            logger.warn('[DeviceControl] Contact lookup failed:', e?.message);
        }
    }

    if (!finalPhone) {
        return {
            error: resolvedName
                ? `Geen telefoonnummer gevonden in je contacten voor "${resolvedName}". Geef eventueel het nummer rechtstreeks mee.`
                : 'Geen contactnaam of telefoonnummer opgegeven.'
        };
    }

    if (channel === 'call') {
        if (Capacitor.isNativePlatform()) {
            try {
                await DeviceControlPlugin.dialNumber({ phone: finalPhone });
                return { success: true, channel: 'call', recipient: resolvedName || finalPhone, phone: finalPhone };
            } catch (e: any) {
                return { error: e?.message || 'Kon telefoon-app niet openen.' };
            }
        }
        window.open(`tel:${finalPhone}`, '_self');
        return { success: true, channel: 'call', recipient: resolvedName || finalPhone, phone: finalPhone };
    }

    if (channel === 'whatsapp') {
        const cleanDigits = finalPhone.replace(/^\+/, '').replace(/\D/g, '');
        const waUrl = `https://wa.me/${cleanDigits}?text=${encodeURIComponent(text)}`;
        try {
            if (Capacitor.isNativePlatform()) {
                await Browser.open({ url: waUrl, presentationStyle: 'popover' });
            } else {
                window.open(waUrl, '_blank', 'noopener,noreferrer');
            }
            return { success: true, channel: 'whatsapp', recipient: resolvedName || finalPhone, phone: finalPhone, message: text, url: waUrl };
        } catch (e: any) {
            return { error: e?.message || 'Kon WhatsApp niet openen.' };
        }
    }

    // SMS
    const smsUrl = `sms:${finalPhone}?body=${encodeURIComponent(text)}`;
    try {
        window.open(smsUrl, '_system');
        return { success: true, channel: 'sms', recipient: resolvedName || finalPhone, phone: finalPhone, message: text };
    } catch (e: any) {
        return { error: e?.message || 'Kon SMS-app niet openen.' };
    }
}
