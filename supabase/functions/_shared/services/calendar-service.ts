
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Set app-level user context for RLS enforcement.
 * This ensures RLS policies can verify the user even when using service role.
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
        throw new Error('Google Calendar not connected.');
    }

    const token = tokenData as GoogleToken;
    const expiresAt = new Date(token.expires_at).getTime();
    const now = Date.now();

    if (expiresAt > now + 5 * 60 * 1000) {
        return token.access_token;
    }

    // Refresh Token
    console.log('[CalendarService] Refreshing token...');
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



export async function getUpcomingEvents(userId: string, limit: number = 10) {
    try {
        const token = await getAccessToken(userId);

        const now = new Date().toISOString();
        const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&maxResults=${limit}&orderBy=startTime&singleEvents=true`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        return data.items.map((event: any) => ({
            id: event.id,
            summary: event.summary,
            start: event.start.dateTime || event.start.date,
            end: event.end.dateTime || event.end.date,
            location: event.location,
            description: event.description
        }));
    } catch (e: any) {
        console.error('[CalendarService] Error:', e);
        return [];
    }
}

export async function createEvent(userId: string, summary: string, startTime: string, durationMinutes: number = 60, timezone?: string) {
    const token = await getAccessToken(userId);

    // Parse the startTime and calculate end time
    // If timezone provided, we use local time string with timezone
    // Otherwise fall back to UTC
    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    // Format datetime for Google API (without Z suffix for timezone-aware)
    const formatDateTime = (date: Date) => {
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    // Build start/end objects with optional timezone
    // Google Calendar API throws 400 Bad Request if you provide 'Z' (UTC) suffix AND a timeZone field.
    // Also, dateTime MUST be RFC3339 compliant (e.g. T10:00:00).

    // Normalize start time: Ensure it has seconds if missing (e.g. T14:00 -> T14:00:00) 
    let startDateTime = startTime.includes('T') ? startTime : `${startTime}T00:00:00`;
    // If it looks like HH:mm (len 5 after T), append :00
    if (startDateTime.match(/T\d{2}:\d{2}$/)) {
        startDateTime += ':00';
    }

    let endDateTime = formatDateTime(end);

    if (timezone) {
        // Strip 'Z' if present
        if (startDateTime.endsWith('Z')) startDateTime = startDateTime.slice(0, -1);

        // Normalize end time similarly
        // endDateTime from formatDateTime() already has seconds and no Z.
        // Just ensuring.
        endDateTime = endDateTime.replace('Z', '');
    }

    const startObj: any = timezone
        ? { dateTime: startDateTime, timeZone: timezone }
        : { dateTime: start.toISOString() }; // Keep Z if no timezone (UTC)

    const endObj: any = timezone
        ? { dateTime: endDateTime, timeZone: timezone }
        : { dateTime: end.toISOString() };

    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            summary,
            start: startObj,
            end: endObj
        })
    });


    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return data;
}

export async function updateEvent(userId: string, eventId: string, summary: string, startTime: string, durationMinutes: number = 60) {
    const token = await getAccessToken(userId);

    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            summary,
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() }
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return data;
}

export async function deleteEvent(userId: string, eventId: string) {
    const token = await getAccessToken(userId);

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });

    if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to delete event');
    }

    return true;
}
