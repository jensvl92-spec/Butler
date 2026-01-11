
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
    console.log('[TasksService] Refreshing token...');
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
 * Get all task lists.
 */
export async function getTaskLists(userId: string) {
    try {
        const token = await getAccessToken(userId);

        const response = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        return data.items?.map((list: any) => ({
            id: list.id,
            title: list.title,
            updated: list.updated
        })) || [];
    } catch (e: any) {
        console.error('[TasksService] Error listing task lists:', e);
        return [];
    }
}

/**
 * Get tasks from a specific list.
 */
export async function getTasks(userId: string, taskListId: string = '@default', limit: number = 10) {
    try {
        const token = await getAccessToken(userId);

        const url = `https://tasks.googleapis.com/tasks/v1/lists/${taskListId}/tasks?maxResults=${limit}&showCompleted=false`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        return data.items?.map((task: any) => ({
            id: task.id,
            title: task.title,
            notes: task.notes || '',
            due: task.due,
            status: task.status,
            updated: task.updated
        })) || [];
    } catch (e: any) {
        console.error('[TasksService] Error listing tasks:', e);
        return [];
    }
}

/**
 * Create a new task.
 */
export async function createTask(userId: string, title: string, notes?: string, dueDate?: string, taskListId: string = '@default') {
    const token = await getAccessToken(userId);

    const taskBody: any = { title };
    if (notes) taskBody.notes = notes;
    if (dueDate) taskBody.due = new Date(dueDate).toISOString();

    const response = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${taskListId}/tasks`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(taskBody)
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return {
        id: data.id,
        title: data.title,
        notes: data.notes,
        due: data.due
    };
}

/**
 * Complete a task.
 */
export async function completeTask(userId: string, taskId: string, taskListId: string = '@default') {
    const token = await getAccessToken(userId);

    const response = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${taskListId}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            status: 'completed'
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return true;
}

/**
 * Delete a task.
 */
export async function deleteTask(userId: string, taskId: string, taskListId: string = '@default') {
    const token = await getAccessToken(userId);

    const response = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${taskListId}/tasks/${taskId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to delete task');
    }

    return true;
}

/**
 * Create a new task list.
 */
export async function createTaskList(userId: string, title: string) {
    const token = await getAccessToken(userId);

    const response = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ title })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return {
        id: data.id,
        title: data.title
    };
}
