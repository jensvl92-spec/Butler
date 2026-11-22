import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export interface LogEntry {
    timestamp: string;
    level: 'INFO' | 'WARN' | 'ERROR';
    message: string;
    data?: string;
}

const MAX_LOGS = 500;
const STORAGE_KEY = 'app_debug_logs';

/**
 * Redacts sensitive tokens, bearer headers, and OAuth URL fragments/query params from log strings.
 */
export function redactSensitiveText(input: string): string {
    if (!input) return input;
    return input
        .replace(/(access_token|refresh_token|provider_token|provider_refresh_token|api_token|ha_token|api_key|apikey|token|key)=([^&\s#"']+)/gi, '$1=[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
        .replace(/AIzaSy[A-Za-z0-9_-]{20,}/g, 'AIzaSy[REDACTED]')
        .replace(/sk-or-v1-[A-Za-z0-9_-]{20,}/g, 'sk-or-v1-[REDACTED]');
}

function safeSerialize(data: any): string | undefined {
    if (data === undefined || data === null) return undefined;
    try {
        let raw: string;
        if (data instanceof Error) {
            raw = JSON.stringify({ name: data.name, message: data.message, stack: data.stack });
        } else if (typeof data === 'object') {
            const seen = new WeakSet();
            raw = JSON.stringify(data, (_k, v) => {
                if (typeof v === 'object' && v !== null) {
                    if (seen.has(v)) return '[Circular]';
                    seen.add(v);
                }
                return v;
            });
        } else {
            raw = String(data);
        }
        return redactSensitiveText(raw).slice(0, 2000);
    } catch {
        return '[Unserializable data]';
    }
}

class LoggerService {
    private logs: LogEntry[] = [];
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        this.loadLogs();
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', () => this.flushLogs());
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') this.flushLogs();
            });
        }
    }

    private loadLogs() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed)) {
                    this.logs = parsed.slice(-MAX_LOGS);
                }
            }
        } catch (e) {
            console.error('Failed to load logs', e);
            this.logs = [];
        }
    }

    private scheduleSave() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flushLogs();
        }, 1500);
    }

    private flushLogs() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.logs));
        } catch {
            // Trim logs on quota pressure and retry once
            try {
                this.logs = this.logs.slice(-100);
                localStorage.setItem(STORAGE_KEY, JSON.stringify(this.logs));
            } catch { }
        }
    }

    private addEntry(level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: any) {
        const cleanMessage = redactSensitiveText(String(message));
        const serializedData = safeSerialize(data);
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message: cleanMessage,
            ...(serializedData !== undefined ? { data: serializedData } : {})
        };

        this.logs.push(entry);
        if (this.logs.length > MAX_LOGS) {
            this.logs = this.logs.slice(-MAX_LOGS);
        }

        this.scheduleSave();

        const consoleFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
        if (serializedData !== undefined) {
            consoleFn(`[${entry.level}] ${entry.message}`, serializedData);
        } else {
            consoleFn(`[${entry.level}] ${entry.message}`);
        }
    }

    info(message: string, data?: any) {
        this.addEntry('INFO', message, data);
    }

    warn(message: string, data?: any) {
        this.addEntry('WARN', message, data);
    }

    error(message: string, data?: any) {
        this.addEntry('ERROR', message, data);
    }

    getLogs() {
        return this.logs;
    }

    clearLogs() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.logs = [];
        this.flushLogs();
    }

    async downloadLogs() {
        const content = this.logs
            .map(l => `[${l.timestamp}] [${l.level}] ${l.message}${l.data ? '\nData: ' + l.data : ''}`)
            .join('\n\n-------------------\n\n');

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
                    title: 'Butler Debug Logs',
                    text: 'Sharing Butler debug logs',
                    url: result.uri,
                    dialogTitle: 'Share Debug Logs'
                });
            } catch (e) {
                console.error('Native export failed', e);
                this.error('Native Log Export Failed', e);
            }
        } else {
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `debug_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }
}

export const logger = new LoggerService();
