/**
 * SOTA Unified Google Workspace & Spotify Client Service
 *
 * Uses the user's Supabase-stored OAuth tokens (`user_tokens`) or active Google session token
 * for low-latency direct API calls (Calendar, Docs, Sheets, Tasks, Gmail, Spotify, YouTube),
 * with automatic silent refresh via `workspace-bridge` Edge Function if deployed.
 */

import { supabase } from '../supabase';
import { fetchWithTimeout } from '../../utils/home-assistant';
import { logger } from '../../utils/logger';

export interface ConnectedAccountStatus {
    connected: boolean;
    expired: boolean;
    hasRefreshToken: boolean;
    expiresAt: string | null;
}

export async function getConnectedAccountsStatus(): Promise<{
    google: ConnectedAccountStatus;
    spotify: ConnectedAccountStatus;
}> {
    const empty: ConnectedAccountStatus = { connected: false, expired: false, hasRefreshToken: false, expiresAt: null };
    try {
        const { data: sessionData } = await supabase.auth.getSession();
        const userId = sessionData?.session?.user?.id;
        if (!userId) return { google: empty, spotify: empty };

        const { data: rows } = await supabase
            .from('user_tokens')
            .select('provider, access_token, refresh_token, expires_at')
            .eq('user_id', userId);

        const now = Date.now();
        const toStatus = (provider: 'google' | 'spotify'): ConnectedAccountStatus => {
            const row = (rows || []).find((r: any) => r.provider === provider);
            if (!row?.access_token) {
                if (provider === 'google' && sessionData?.session?.provider_token) {
                    return { connected: true, expired: false, hasRefreshToken: !!sessionData.session.provider_refresh_token, expiresAt: null };
                }
                return empty;
            }
            const expMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
            const expired = expMs > 0 ? expMs <= now + 60_000 : false;
            return {
                connected: true,
                expired,
                hasRefreshToken: !!row.refresh_token,
                expiresAt: row.expires_at || null
            };
        };

        return { google: toStatus('google'), spotify: toStatus('spotify') };
    } catch {
        return { google: empty, spotify: empty };
    }
}

async function getValidProviderToken(provider: 'google' | 'spotify'): Promise<{ token?: string; error?: string; needsOAuth?: boolean }> {
    const label = provider === 'google' ? 'Google Workspace' : 'Spotify';
    try {
        const { data: sessionData } = await supabase.auth.getSession();
        const session = sessionData?.session;
        const userId = session?.user?.id;

        if (!userId) {
            return { error: `Log eerst in om ${label} te gebruiken.`, needsOAuth: true };
        }

        // 1. Check user_tokens table
        const { data: tokenRow } = await supabase
            .from('user_tokens')
            .select('access_token, refresh_token, expires_at')
            .eq('user_id', userId)
            .eq('provider', provider)
            .maybeSingle();

        const now = Date.now();
        if (tokenRow?.access_token) {
            const expMs = tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() : 0;
            if (!expMs || expMs > now + 2 * 60 * 1000) {
                return { token: tokenRow.access_token };
            }

            // 2. Token expired -> attempt silent refresh via workspace-bridge Edge Function if deployed
            if (tokenRow.refresh_token) {
                try {
                    const { data: refreshed, error: fnErr } = await supabase.functions.invoke('workspace-bridge', {
                        body: { action: 'refresh_token', provider }
                    });
                    if (!fnErr && refreshed?.access_token) {
                        return { token: refreshed.access_token };
                    }
                } catch (e) {
                    logger.warn(`[Workspace] Silent ${provider} token refresh unavailable:`, e);
                }
            }
        }

        // 3. Active Google session provider_token fallback
        if (provider === 'google' && session?.provider_token) {
            return { token: session.provider_token };
        }

        return {
            needsOAuth: true,
            error: tokenRow
                ? `Je ${label}-koppeling is verlopen. Open Settings → Gekoppelde Accounts en tik op "Vernieuw ${provider === 'google' ? 'Google' : 'Spotify'}" om direct weer te verbinden.`
                : `${label} is nog niet gekoppeld. Open Settings → Gekoppelde Accounts en tik op "Koppel ${provider === 'google' ? 'Google' : 'Spotify'}".`
        };
    } catch (e: any) {
        return { error: `Fout bij ophalen van ${label}-toegang: ${e?.message || e}` };
    }
}

async function apiJson(url: string, token: string, init?: RequestInit): Promise<any> {
    const res = await fetchWithTimeout(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init?.headers || {})
        }
    }, 15000);

    if (res.status === 204) return { ok: true };
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
        const msg = data?.error?.message || data?.error_description || data?.error || `HTTP ${res.status}`;
        const err: any = new Error(msg);
        err.status = res.status;
        throw err;
    }
    return data;
}

// =============================================================
// 1. GOOGLE CALENDAR (List, Create, Update, Delete)
// =============================================================
function addMinutesToWallClock(localIso: string, durationMinutes: number): string {
    const m = localIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) {
        return new Date(Date.now() + durationMinutes * 60000).toISOString().replace('Z', '');
    }
    const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) + durationMinutes * 60000;
    const d = new Date(utcMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export async function listGoogleCalendarEvents(daysAhead = 7, maxResults = 20) {
    const auth = await getValidProviderToken('google');
    if (!auth.token) return { error: auth.error, needs_oauth: auth.needsOAuth, events: [] };

    const safeDays = Math.max(1, Math.min(daysAhead || 7, 90));
    const now = new Date();
    const end = new Date(now.getTime() + safeDays * 24 * 3600 * 1000);
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}&maxResults=${Math.min(50, maxResults)}&orderBy=startTime&singleEvents=true`;

    const data = await apiJson(url, auth.token);
    const events = (data.items || []).map((ev: any) => ({
        id: ev.id,
        calendar: 'Google Calendar',
        summary: ev.summary || '(Geen titel)',
        start: ev.start?.dateTime || ev.start?.date,
        end: ev.end?.dateTime || ev.end?.date,
        location: ev.location || null,
        description: ev.description || null,
        url: ev.htmlLink || null
    }));
    return { source: 'Google Calendar', total_events: events.length, events };
}

export async function createGoogleCalendarEvent(params: {
    summary: string;
    start_time: string;
    duration_minutes?: number;
    location?: string;
    description?: string;
}) {
    const auth = await getValidProviderToken('google');
    if (!auth.token) return { error: auth.error, needs_oauth: auth.needsOAuth };

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Brussels';
    let cleanStart = (params.start_time.includes('T') ? params.start_time : `${params.start_time}T09:00:00`).replace(/Z$/i, '');
    if (/T\d{2}:\d{2}$/.test(cleanStart)) cleanStart += ':00';
    const duration = Math.max(5, Number(params.duration_minutes) || 60);
    const cleanEnd = addMinutesToWallClock(cleanStart, duration);

    const body: Record<string, any> = {
        summary: params.summary,
        start: { dateTime: cleanStart, timeZone: tz },
        end: { dateTime: cleanEnd, timeZone: tz }
    };
    if (params.location) body.location = params.location;
    if (params.description) body.description = params.description;

    const created = await apiJson('https://www.googleapis.com/calendar/v3/calendars/primary/events', auth.token, {
        method: 'POST',
        body: JSON.stringify(body)
    });

    return {
        success: true,
        id: created.id,
        summary: created.summary,
        start: created.start?.dateTime || created.start?.date,
        end: created.end?.dateTime || created.end?.date,
        url: created.htmlLink || null
    };
}

export async function updateGoogleCalendarEvent(params: {
    event_id: string;
    summary?: string;
    start_time?: string;
    duration_minutes?: number;
    location?: string;
    description?: string;
}) {
    const auth = await getValidProviderToken('google');
    if (!auth.token) return { error: auth.error, needs_oauth: auth.needsOAuth };

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Brussels';
    const patch: Record<string, any> = {};
    if (params.summary) patch.summary = params.summary;
    if (params.location !== undefined) patch.location = params.location;
    if (params.description !== undefined) patch.description = params.description;
    if (params.start_time) {
        let cleanStart = (params.start_time.includes('T') ? params.start_time : `${params.start_time}T09:00:00`).replace(/Z$/i, '');
        if (/T\d{2}:\d{2}$/.test(cleanStart)) cleanStart += ':00';
        const duration = Math.max(5, Number(params.duration_minutes) || 60);
        patch.start = { dateTime: cleanStart, timeZone: tz };
        patch.end = { dateTime: addMinutesToWallClock(cleanStart, duration), timeZone: tz };
    }

    const updated = await apiJson(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(params.event_id)}`,
        auth.token,
        { method: 'PATCH', body: JSON.stringify(patch) }
    );
    return { success: true, id: updated.id, summary: updated.summary, url: updated.htmlLink || null };
}

export async function deleteGoogleCalendarEvent(eventId: string) {
    const auth = await getValidProviderToken('google');
    if (!auth.token) return { error: auth.error, needs_oauth: auth.needsOAuth };

    await apiJson(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
        auth.token,
        { method: 'DELETE' }
    );
    return { success: true, deleted_event_id: eventId };
}

// =============================================================
// 2. GOOGLE DOCS (List, Read, Create, Append, Replace Text)
// =============================================================
function extractDocText(content: any[]): string {
    let text = '';
    for (const el of content || []) {
        if (el.paragraph) {
            for (const pEl of el.paragraph.elements || []) {
                if (pEl.textRun?.content) text += pEl.textRun.content;
            }
        } else if (el.table) {
            for (const row of el.table.tableRows || []) {
                for (const cell of row.tableCells || []) {
                    text += extractDocText(cell.content || []) + '\t';
                }
                text += '\n';
            }
        }
    }
    return text.trim();
}

export async function manageGoogleDocs(args: {
    action: 'list' | 'read' | 'create' | 'append' | 'replace_text';
    document_id?: string;
    query?: string;
    title?: string;
    content?: string;
    find_text?: string;
    replace_with?: string;
}) {
    const auth = await getValidProviderToken('google');
    if (!auth.token) return { error: auth.error, needs_oauth: auth.needsOAuth };

    if (args.action === 'list') {
        let q = "mimeType='application/vnd.google-apps.document' and trashed = false";
        if (args.query?.trim()) {
            const safeQ = args.query.trim().replace(/'/g, "\\'");
            q += ` and name contains '${safeQ}'`;
        }
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=15&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,webViewLink)`;
        const data = await apiJson(url, auth.token);
        return {
            documents: (data.files || []).map((f: any) => ({
                id: f.id,
                name: f.name,
                modifiedTime: f.modifiedTime,
                url: f.webViewLink || `https://docs.google.com/document/d/${f.id}/edit`
            }))
        };
    }

    if (args.action === 'create') {
        const title = (args.title || 'Nieuw Butler Document').trim();
        const created = await apiJson('https://docs.googleapis.com/v1/documents', auth.token, {
            method: 'POST',
            body: JSON.stringify({ title })
        });
        const docId = created.documentId;
        if (args.content?.trim()) {
            await apiJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`, auth.token, {
                method: 'POST',
                body: JSON.stringify({
                    requests: [{ insertText: { location: { index: 1 }, text: args.content } }]
                })
            });
        }
        return {
            success: true,
            id: docId,
            title: created.title,
            url: `https://docs.google.com/document/d/${docId}/edit`
        };
    }

    // Resolve document_id by title/query if omitted
    let docId = (args.document_id || '').trim();
    if (!docId && (args.title || args.query)) {
        const found: any = await manageGoogleDocs({ action: 'list', query: args.title || args.query });
        if (found.documents?.[0]?.id) docId = found.documents[0].id;
    }
    if (!docId) return { error: 'Geen document_id of documentnaam gevonden. Gebruik eerst action="list".' };

    if (args.action === 'read') {
        const doc = await apiJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`, auth.token);
        const text = extractDocText(doc.body?.content || []);
        return {
            id: doc.documentId,
            title: doc.title,
            content: text.slice(0, 12000),
            truncated: text.length > 12000,
            url: `https://docs.google.com/document/d/${docId}/edit`
        };
    }

    if (args.action === 'append') {
        if (!args.content) return { error: 'Geen tekst opgegeven om toe te voegen.' };
        const doc = await apiJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`, auth.token);
        const lastEl = doc.body?.content?.[doc.body.content.length - 1];
        const endIndex = lastEl?.endIndex || 2;
        const insertIndex = Math.max(1, endIndex - 1);
        const textToInsert = endIndex <= 2 ? args.content : `\n${args.content}`;
        await apiJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`, auth.token, {
            method: 'POST',
            body: JSON.stringify({
                requests: [{ insertText: { location: { index: insertIndex }, text: textToInsert } }]
            })
        });
        return {
            success: true,
            id: docId,
            title: doc.title,
            url: `https://docs.google.com/document/d/${docId}/edit`
        };
    }

    if (args.action === 'replace_text') {
        if (!args.find_text) return { error: 'Geef find_text op om te vervangen.' };
        const res = await apiJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`, auth.token, {
            method: 'POST',
            body: JSON.stringify({
                requests: [{
                    replaceAllText: {
                        containsText: { text: args.find_text, matchCase: false },
                        replaceText: args.replace_with ?? ''
                    }
                }]
            })
        });
        const occurrences = res?.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        return {
            success: true,
            id: docId,
            occurrences_replaced: occurrences,
            url: `https://docs.google.com/document/d/${docId}/edit`
        };
    }

    return { error: `Onbekende Google Docs actie: ${args.action}` };
}

// =============================================================
// 3. GOOGLE SHEETS (List, Read, Create, Append Rows, Update Range)
// =============================================================
export async function manageGoogleSheets(args: {
    action: 'list' | 'read' | 'create' | 'append_rows' | 'update_range';
    spreadsheet_id?: string;
    query?: string;
    title?: string;
    range?: string;
    values?: any[][];
}) {
    const auth = await getValidProviderToken('google');
    if (!auth.token) return { error: auth.error, needs_oauth: auth.needsOAuth };

    if (args.action === 'list') {
        let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed = false";
        if (args.query?.trim()) {
            const safeQ = args.query.trim().replace(/'/g, "\\'");
            q += ` and name contains '${safeQ}'`;
        }
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=15&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,webViewLink)`;
        const data = await apiJson(url, auth.token);
        return {
            spreadsheets: (data.files || []).map((f: any) => ({
                id: f.id,
                name: f.name,
                modifiedTime: f.modifiedTime,
                url: f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`
            }))
        };
    }

    if (args.action === 'create') {
        const title = (args.title || 'Nieuwe Butler Spreadsheet').trim();
        const created = await apiJson('https://sheets.googleapis.com/v4/spreadsheets', auth.token, {
            method: 'POST',
            body: JSON.stringify({ properties: { title } })
        });
        const sid = created.spreadsheetId;
        const firstSheet = created.sheets?.[0]?.properties?.title || 'Sheet1';
        if (Array.isArray(args.values) && args.values.length > 0) {
            await apiJson(
                `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${encodeURIComponent(firstSheet)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
                auth.token,
                { method: 'POST', body: JSON.stringify({ values: args.values }) }
            );
        }
        return {
            success: true,
            id: sid,
            title: created.properties?.title || title,
            first_sheet: firstSheet,
            url: created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${sid}/edit`
        };
    }

    let sid = (args.spreadsheet_id || '').trim();
    if (!sid && (args.title || args.query)) {
        const found: any = await manageGoogleSheets({ action: 'list', query: args.title || args.query });
        if (found.spreadsheets?.[0]?.id) sid = found.spreadsheets[0].id;
    }
    if (!sid) return { error: 'Geen spreadsheet_id of naam gevonden. Gebruik eerst action="list".' };

    // Auto-detect actual first sheet name (handles Dutch "Blad1" vs English "Sheet1"!)
    let targetRange = (args.range || '').trim();
    if (!targetRange) {
        const info = await apiJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}?fields=properties.title,sheets.properties.title`, auth.token);
        targetRange = info.sheets?.[0]?.properties?.title || 'Sheet1';
    }

    if (args.action === 'read') {
        const data = await apiJson(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${encodeURIComponent(targetRange)}`,
            auth.token
        );
        return {
            id: sid,
            range: data.range || targetRange,
            values: (data.values || []).slice(0, 100),
            url: `https://docs.google.com/spreadsheets/d/${sid}/edit`
        };
    }

    if (args.action === 'append_rows') {
        if (!Array.isArray(args.values) || args.values.length === 0) {
            return { error: 'Geef minstens één rij in values (bijv. [["Datum", "Bedrag"]]).' };
        }
        const data = await apiJson(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${encodeURIComponent(targetRange)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
            auth.token,
            { method: 'POST', body: JSON.stringify({ values: args.values }) }
        );
        return {
            success: true,
            id: sid,
            updated_range: data.updates?.updatedRange || targetRange,
            updated_rows: data.updates?.updatedRows || args.values.length,
            url: `https://docs.google.com/spreadsheets/d/${sid}/edit`
        };
    }

    if (args.action === 'update_range') {
        if (!Array.isArray(args.values) || args.values.length === 0) {
            return { error: 'Geef values mee om de cellen bij te werken.' };
        }
        const data = await apiJson(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${encodeURIComponent(targetRange)}?valueInputOption=USER_ENTERED`,
            auth.token,
            { method: 'PUT', body: JSON.stringify({ range: targetRange, values: args.values }) }
        );
        return {
            success: true,
            id: sid,
            updated_range: data.updatedRange || targetRange,
            url: `https://docs.google.com/spreadsheets/d/${sid}/edit`
        };
    }

    return { error: `Onbekende Google Sheets actie: ${args.action}` };
}

// =============================================================
// 4. GOOGLE TASKS (Lists, List Items, Add, Add Many, Complete, Remove)
// =============================================================
export async function manageGoogleTasks(args: {
    action: 'list_lists' | 'list' | 'add' | 'add_many' | 'complete' | 'remove';
    list_id?: string;
    item?: string;
    items?: string[];
    notes?: string;
    due_date?: string;
}) {
    const auth = await getValidProviderToken('google');
    if (!auth.token) return { error: auth.error, needs_oauth: auth.needsOAuth };

    const listId = (args.list_id || '@default').trim();

    if (args.action === 'list_lists') {
        const data = await apiJson('https://tasks.googleapis.com/tasks/v1/users/@me/lists', auth.token);
        return {
            lists: (data.items || []).map((l: any) => ({ id: l.id, title: l.title }))
        };
    }

    if (args.action === 'list') {
        const data = await apiJson(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks?maxResults=30&showCompleted=false`, auth.token);
        return {
            source: 'Google Tasks',
            list_id: listId,
            tasks: (data.items || []).map((t: any) => ({ id: t.id, title: t.title, notes: t.notes || '', due: t.due || null }))
        };
    }

    if (args.action === 'add' && args.item) {
        const body: any = { title: args.item };
        if (args.notes) body.notes = args.notes;
        if (args.due_date) body.due = new Date(args.due_date).toISOString();
        const created = await apiJson(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`, auth.token, {
            method: 'POST',
            body: JSON.stringify(body)
        });
        return { success: true, source: 'Google Tasks', id: created.id, title: created.title };
    }

    if (args.action === 'add_many' && Array.isArray(args.items) && args.items.length > 0) {
        const added: string[] = [];
        for (const title of args.items.slice(0, 30)) {
            const clean = String(title || '').trim();
            if (!clean) continue;
            await apiJson(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`, auth.token, {
                method: 'POST',
                body: JSON.stringify({ title: clean })
            });
            added.push(clean);
        }
        return { success: true, source: 'Google Tasks', added_count: added.length, items: added };
    }

    if ((args.action === 'complete' || args.action === 'remove') && args.item) {
        const listRes: any = await manageGoogleTasks({ action: 'list', list_id: listId });
        const needle = args.item.toLowerCase().trim();
        const match = (listRes.tasks || []).find((t: any) => t.id === args.item || (t.title || '').toLowerCase().includes(needle));
        if (!match) return { error: `Taak "${args.item}" niet gevonden in Google Tasks.` };

        if (args.action === 'complete') {
            await apiJson(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(match.id)}`, auth.token, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'completed' })
            });
            return { success: true, completed: match.title };
        } else {
            await apiJson(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(match.id)}`, auth.token, {
                method: 'DELETE'
            });
            return { success: true, removed: match.title };
        }
    }

    return { error: 'Ongeldige Google Tasks actie of ontbrekende itemnaam.' };
}

// =============================================================
// 5. GMAIL (List Unread, Search, Read Full Body, Send)
// =============================================================
function decodeBase64UrlUtf8(data?: string): string {
    if (!data) return '';
    try {
        const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return '';
    }
}

function extractGmailBody(payload: any): string {
    if (!payload) return '';
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return decodeBase64UrlUtf8(payload.body.data);
    }
    if (Array.isArray(payload.parts)) {
        for (const p of payload.parts) {
            if (p.mimeType === 'text/plain' && p.body?.data) {
                return decodeBase64UrlUtf8(p.body.data);
            }
        }
        for (const p of payload.parts) {
            const nested = extractGmailBody(p);
            if (nested) return nested;
        }
    }
    if (payload.body?.data) {
        return decodeBase64UrlUtf8(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return '';
}

export async function manageGmail(args: {
    action: 'list_unread' | 'search' | 'read' | 'send';
    query?: string;
    message_id?: string;
    to?: string;
    subject?: string;
    body?: string;
    limit?: number;
}) {
    const auth = await getValidProviderToken('google');
    if (!auth.token) return { error: auth.error, needs_oauth: auth.needsOAuth };

    if (args.action === 'list_unread' || args.action === 'search') {
        const q = args.action === 'list_unread' ? 'is:unread' : (args.query || 'in:inbox');
        const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
        const list = await apiJson(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${limit}`,
            auth.token
        );
        const msgs = list.messages || [];
        if (msgs.length === 0) return { total: 0, emails: [] };

        const detailed = await Promise.all(
            msgs.map(async (m: any) => {
                const d = await apiJson(
                    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
                    auth.token!
                );
                const hdrs = d.payload?.headers || [];
                return {
                    id: m.id,
                    from: hdrs.find((h: any) => h.name === 'From')?.value || 'Onbekend',
                    subject: hdrs.find((h: any) => h.name === 'Subject')?.value || '(Geen onderwerp)',
                    date: hdrs.find((h: any) => h.name === 'Date')?.value || '',
                    snippet: d.snippet || ''
                };
            })
        );
        return { total: detailed.length, emails: detailed };
    }

    if (args.action === 'read') {
        if (!args.message_id) return { error: 'Geen message_id opgegeven.' };
        const d = await apiJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.message_id)}?format=full`, auth.token);
        const hdrs = d.payload?.headers || [];
        const bodyText = extractGmailBody(d.payload) || d.snippet || '';
        return {
            id: d.id,
            from: hdrs.find((h: any) => h.name === 'From')?.value || 'Onbekend',
            subject: hdrs.find((h: any) => h.name === 'Subject')?.value || '(Geen onderwerp)',
            date: hdrs.find((h: any) => h.name === 'Date')?.value || '',
            body: bodyText.slice(0, 6000)
        };
    }

    if (args.action === 'send') {
        if (!args.to || !args.subject || !args.body) {
            return { error: 'Voor e-mail versturen zijn to, subject en body vereist.' };
        }
        const safeTo = args.to.replace(/[\r\n]+/g, ' ').trim();
        const safeSubject = args.subject.replace(/[\r\n]+/g, ' ').trim();
        const rawEmail = `To: ${safeTo}\r\nSubject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(safeSubject)))}?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}`;
        const bytes = new TextEncoder().encode(rawEmail);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        const sent = await apiJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', auth.token, {
            method: 'POST',
            body: JSON.stringify({ raw: encoded })
        });
        return { success: true, id: sent.id, to: safeTo, subject: safeSubject };
    }

    return { error: `Onbekende Gmail actie: ${args.action}` };
}

// =============================================================
// 6. SPOTIFY & YOUTUBE MEDIA CONTROL
// =============================================================
export async function controlSpotify(args: {
    command: 'status' | 'play' | 'pause' | 'next' | 'previous' | 'volume';
    query?: string;
    volume_percent?: number;
}) {
    const auth = await getValidProviderToken('spotify');
    if (!auth.token) return { error: auth.error, needs_oauth: auth.needsOAuth };

    if (args.command === 'status') {
        const res = await fetchWithTimeout('https://api.spotify.com/v1/me/player', {
            headers: { Authorization: `Bearer ${auth.token}` }
        }, 10000);
        if (res.status === 204) return { is_playing: false, message: 'Er speelt momenteel niets op Spotify.' };
        const data = await res.json();
        return {
            is_playing: !!data.is_playing,
            track: data.item?.name || null,
            artist: Array.isArray(data.item?.artists) ? data.item.artists.map((a: any) => a.name).join(', ') : null,
            album: data.item?.album?.name || null,
            device: data.device?.name || null,
            volume_percent: data.device?.volume_percent ?? null
        };
    }

    if (args.command === 'pause') {
        await apiJson('https://api.spotify.com/v1/me/player/pause', auth.token, { method: 'PUT' });
        return { success: true, message: 'Spotify gepauzeerd.' };
    }
    if (args.command === 'next') {
        await apiJson('https://api.spotify.com/v1/me/player/next', auth.token, { method: 'POST' });
        return { success: true, message: 'Volgend nummer op Spotify.' };
    }
    if (args.command === 'previous') {
        await apiJson('https://api.spotify.com/v1/me/player/previous', auth.token, { method: 'POST' });
        return { success: true, message: 'Vorig nummer op Spotify.' };
    }
    if (args.command === 'volume') {
        const vol = Math.max(0, Math.min(100, Math.round(Number(args.volume_percent) || 50)));
        await apiJson(`https://api.spotify.com/v1/me/player/volume?volume_percent=${vol}`, auth.token, { method: 'PUT' });
        return { success: true, volume_percent: vol };
    }

    // Play or search & play
    const q = (args.query || '').trim();
    if (!q) {
        await apiJson('https://api.spotify.com/v1/me/player/play', auth.token, { method: 'PUT' });
        return { success: true, message: 'Spotify hervat.' };
    }

    const search = await apiJson(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track,album,artist,playlist&limit=1`,
        auth.token
    );
    let uri = '';
    let label = '';
    let isTrack = false;
    if (search.tracks?.items?.[0]) {
        const t = search.tracks.items[0];
        uri = t.uri;
        label = `${t.name} van ${t.artists?.[0]?.name || ''}`;
        isTrack = true;
    } else if (search.playlists?.items?.[0]) {
        uri = search.playlists.items[0].uri;
        label = search.playlists.items[0].name;
    } else if (search.albums?.items?.[0]) {
        uri = search.albums.items[0].uri;
        label = search.albums.items[0].name;
    } else if (search.artists?.items?.[0]) {
        uri = search.artists.items[0].uri;
        label = search.artists.items[0].name;
    } else {
        return { error: `Niets gevonden op Spotify voor "${q}".` };
    }

    try {
        await apiJson('https://api.spotify.com/v1/me/player/play', auth.token, {
            method: 'PUT',
            body: JSON.stringify(isTrack ? { uris: [uri] } : { context_uri: uri })
        });
        return { success: true, playing: label, uri };
    } catch (e: any) {
        if (e?.status === 404) {
            return {
                error: 'Geen actief Spotify-apparaat gevonden. Ik kan wel direct de Spotify-app openen met je zoekopdracht.',
                no_active_device: true,
                query: q
            };
        }
        throw e;
    }
}

export async function searchYouTubeVideos(query: string, limit = 5) {
    const cleanQ = (query || '').trim();
    if (!cleanQ) return { error: 'Geen YouTube-zoekterm opgegeven.' };

    // 1. Direct YouTube URL / video ID shortcut
    const directIdMatch = cleanQ.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (directIdMatch?.[1]) {
        const vid = directIdMatch[1];
        return {
            source: 'YouTube Direct',
            query: cleanQ,
            videos: [{ title: cleanQ, channel: '', video_id: vid, url: `https://www.youtube.com/watch?v=${vid}` }]
        };
    }

    // 2. Authenticated YouTube Data API v3 (when Google is connected & YouTube API is enabled)
    const auth = await getValidProviderToken('google');
    if (auth.token) {
        try {
            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${Math.min(8, limit)}&q=${encodeURIComponent(cleanQ)}`;
            const data = await apiJson(url, auth.token);
            const videos = (data.items || [])
                .filter((item: any) => item?.id?.videoId)
                .map((item: any) => ({
                    title: item.snippet?.title,
                    channel: item.snippet?.channelTitle,
                    video_id: item.id?.videoId,
                    url: `https://www.youtube.com/watch?v=${item.id?.videoId}`
                }));
            if (videos.length > 0) {
                return { source: 'YouTube API', query: cleanQ, videos };
            }
        } catch { }
    }

    // 3. Zero-API-key instant resolver via YouTube search page (works natively via CapacitorHttp on Android!)
    try {
        const res = await fetchWithTimeout(
            `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ)}`,
            {
                headers: {
                    'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8'
                }
            },
            6000
        );
        if (res.ok) {
            const html = await res.text();
            const videos: Array<{ title: string; channel: string; video_id: string; url: string }> = [];
            const seen = new Set<string>();
            const rendererRegex = /"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]*?"title":\{"runs":\[\{"text":"((?:\\.|[^"\\])*)"\}\]/g;
            let match: RegExpExecArray | null;
            while ((match = rendererRegex.exec(html)) !== null && videos.length < Math.min(8, limit)) {
                const videoId = match[1];
                if (seen.has(videoId)) continue;
                seen.add(videoId);
                let title = match[2];
                try { title = JSON.parse(`"${match[2]}"`); } catch { }
                videos.push({
                    title,
                    channel: '',
                    video_id: videoId,
                    url: `https://www.youtube.com/watch?v=${videoId}`
                });
            }
            if (videos.length === 0) {
                const fallbackIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
                if (fallbackIdMatch?.[1]) {
                    const videoId = fallbackIdMatch[1];
                    videos.push({
                        title: cleanQ,
                        channel: '',
                        video_id: videoId,
                        url: `https://www.youtube.com/watch?v=${videoId}`
                    });
                }
            }
            if (videos.length > 0) {
                return { source: 'YouTube Search', query: cleanQ, videos };
            }
        }
    } catch { }

    return {
        source: 'YouTube Link',
        query: cleanQ,
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ)}`,
        message: `YouTube-zoeklink klaar voor "${cleanQ}".`
    };
}
