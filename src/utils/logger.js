import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
const MAX_LOGS = 1000;
const STORAGE_KEY = 'app_debug_logs';
class LoggerService {
    constructor() {
        Object.defineProperty(this, "logs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        this.loadLogs();
    }
    loadLogs() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                this.logs = JSON.parse(stored);
            }
        }
        catch (e) {
            console.error('Failed to load logs', e);
        }
    }
    saveLogs() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.logs));
        }
        catch (e) {
            console.error('Failed to save logs', e);
        }
    }
    addEntry(level, message, data) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            data: data instanceof Error
                ? JSON.stringify(data, Object.getOwnPropertyNames(data))
                : (typeof data === 'object' ? JSON.stringify(data) : String(data))
        };
        this.logs.push(entry);
        if (this.logs.length > MAX_LOGS) {
            this.logs = this.logs.slice(-MAX_LOGS);
        }
        this.saveLogs();
        // Also log to console for dev
        console.log(`[${entry.level}] ${entry.message}`, data || '');
    }
    info(message, data) {
        this.addEntry('INFO', message, data);
    }
    warn(message, data) {
        this.addEntry('WARN', message, data);
    }
    error(message, data) {
        this.addEntry('ERROR', message, data);
    }
    getLogs() {
        return this.logs;
    }
    clearLogs() {
        this.logs = [];
        this.saveLogs();
    }
    async downloadLogs() {
        let content = this.logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message} ${l.data ? '\nData: ' + l.data : ''}`).join('\n\n-------------------\n\n');
        try {
            const { supabase } = await import('../lib/supabase'); // Dynamic import
            const { data: serverLogs } = await supabase.from('scheduler_logs').select('*').order('created_at', { ascending: false }).limit(20);
            if (serverLogs && serverLogs.length > 0) {
                content += "\n\n\n\n========== SERVER SCHEDULER LOGS (Last 20) ==========\n\n";
                content += serverLogs.map((l) => `[${l.created_at}] [${l.level}] ${l.message} ${l.details ? JSON.stringify(l.details) : ''}`).join('\n\n');
            }
            else {
                content += "\n\n\n\n========== SERVER SCHEDULER LOGS ==========\nNo server logs found (or not accessible).";
            }
        }
        catch (e) {
            content += "\n\nFailed to fetch server logs: " + e;
        }
        if (Capacitor.isNativePlatform()) {
            try {
                const fileName = `debug_logs_${Date.now()}.txt`;
                const result = await Filesystem.writeFile({
                    path: fileName,
                    data: content,
                    directory: Directory.Cache,
                    encoding: Encoding.UTF8
                });
                await Share.share({
                    title: 'Debug Logs',
                    text: 'Sharing debug logs',
                    url: result.uri,
                    dialogTitle: 'Share Debug Logs'
                });
            }
            catch (e) {
                console.error("Native export failed", e);
                this.error("Native Log Export Failed", e);
            }
        }
        else {
            // Web Fallback
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `debug_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }
}
export const logger = new LoggerService();
