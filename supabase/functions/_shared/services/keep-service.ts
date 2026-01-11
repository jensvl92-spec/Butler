
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Set app-level user context for RLS enforcement.
 */
async function setAppUserContext(userId: string): Promise<void> {
    await supabaseAdmin.rpc('set_app_user', { p_user_id: userId });
}

interface GoogleToken {
    access_token: string;
    refresh_token: string;
    expires_at: string;
}

/**
 * Get a valid access token for the user.
 */
async function getAccessToken(userId: string): Promise<string> {
    // Set RLS context for defense-in-depth
    await setAppUserContext(userId);

    const { data: tokenData, error } = await supabaseAdmin
        .from('user_tokens')
        .select('*')
        .eq('user_id', userId)
        .eq('provider', 'google')
        .single();

    if (error || !tokenData) {
        throw new Error('Google account not connected.');
    }

    const token = tokenData as GoogleToken;
    const expiresAt = new Date(token.expires_at).getTime();
    const now = Date.now();

    if (expiresAt > now + 5 * 60 * 1000) {
        return token.access_token;
    }

    // Refresh Token
    console.log('[KeepService] Refreshing token...');
    const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: token.refresh_token,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET
        })
    });

    const newData = await refreshResponse.json();

    if (newData.error) {
        throw new Error(`Failed to refresh Google token: ${newData.error_description || newData.error}`);
    }

    const newExpiresAt = new Date(Date.now() + newData.expires_in * 1000).toISOString();

    await supabaseAdmin
        .from('user_tokens')
        .update({
            access_token: newData.access_token,
            expires_at: newExpiresAt,
            updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('provider', 'google');

    return newData.access_token;
}



/**
 * List notes from Google Keep.
 */
export async function getNotes(userId: string, limit: number = 10) {
    try {
        const token = await getAccessToken(userId);

        const url = `https://keep.googleapis.com/v1/notes?pageSize=${limit}`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        return data.notes?.map((note: any) => ({
            id: note.name?.split('/')[1] || note.name,
            title: note.title || '(Untitled)',
            content: extractNoteContent(note),
            createTime: note.createTime,
            updateTime: note.updateTime,
            trashed: note.trashed || false
        })) || [];
    } catch (e: any) {
        console.error('[KeepService] Error listing notes:', e);
        return [];
    }
}

/**
 * Extract readable content from a Keep note.
 */
function extractNoteContent(note: any): string {
    if (note.body?.text?.text) {
        return note.body.text.text;
    }
    if (note.body?.list?.listItems) {
        return note.body.list.listItems
            .map((item: any) => {
                const checked = item.checked ? '☑' : '☐';
                const text = item.text?.text || '';
                return `${checked} ${text}`;
            })
            .join('\n');
    }
    return '';
}

/**
 * Create a text note in Google Keep.
 */
export async function createNote(userId: string, title: string, content: string) {
    const token = await getAccessToken(userId);

    const response = await fetch('https://keep.googleapis.com/v1/notes', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            title,
            body: {
                text: {
                    text: content
                }
            }
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return {
        id: data.name?.split('/')[1] || data.name,
        title: data.title,
        content: extractNoteContent(data)
    };
}

/**
 * Create a list/checklist note in Google Keep.
 */
export async function createListNote(userId: string, title: string, items: string[]) {
    const token = await getAccessToken(userId);

    const response = await fetch('https://keep.googleapis.com/v1/notes', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            title,
            body: {
                list: {
                    listItems: items.map(item => ({
                        text: { text: item },
                        checked: false
                    }))
                }
            }
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return {
        id: data.name?.split('/')[1] || data.name,
        title: data.title,
        items: items.length
    };
}

/**
 * Delete a note from Google Keep.
 */
export async function deleteNote(userId: string, noteId: string) {
    const token = await getAccessToken(userId);

    // The Keep API uses soft delete (trash)
    const response = await fetch(`https://keep.googleapis.com/v1/notes/${noteId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to delete note');
    }

    return true;
}

/**
 * Get a specific note by ID.
 */
export async function getNote(userId: string, noteId: string) {
    const token = await getAccessToken(userId);

    const response = await fetch(`https://keep.googleapis.com/v1/notes/${noteId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return {
        id: data.name?.split('/')[1] || data.name,
        title: data.title || '(Untitled)',
        content: extractNoteContent(data),
        createTime: data.createTime,
        updateTime: data.updateTime
    };
}
