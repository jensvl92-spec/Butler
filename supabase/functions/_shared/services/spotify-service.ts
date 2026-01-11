
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SPOTIFY_CLIENT_ID = Deno.env.get('SPOTIFY_CLIENT_ID') || '';
const SPOTIFY_CLIENT_SECRET = Deno.env.get('SPOTIFY_CLIENT_SECRET') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Set app-level user context for RLS enforcement.
 */
async function setAppUserContext(userId: string): Promise<void> {
    await supabaseAdmin.rpc('set_app_user', { p_user_id: userId });
}

interface SpotifyToken {
    access_token: string;
    refresh_token: string;
    expires_at: string;
}

/**
 * Get a valid access token for the user.
 * Refreshes the token if it's expired.
 */
async function getAccessToken(userId: string): Promise<string> {
    // Set RLS context for defense-in-depth
    await setAppUserContext(userId);

    // 1. Fetch token from DB
    const { data: tokenData, error } = await supabaseAdmin
        .from('user_tokens')
        .select('*')
        .eq('user_id', userId)
        .eq('provider', 'spotify')
        .single();

    if (error || !tokenData) {
        throw new Error('Spotify not connected. Please ask the user to log in.');
    }

    const token = tokenData as SpotifyToken;
    const expiresAt = new Date(token.expires_at).getTime();
    const now = Date.now();

    // 2. Check partial expiry (refresh 5 minutes before actual expiry)
    if (expiresAt > now + 5 * 60 * 1000) {
        return token.access_token;
    }

    // 3. Refresh Token
    console.log('[SpotifyService] Refreshing token...');
    const refreshResponse = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`)}`
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: token.refresh_token
        })
    });

    const newData = await refreshResponse.json();

    if (newData.error) {
        console.error('[SpotifyService] Refresh failed:', newData);
        throw new Error(`Failed to refresh Spotify token: ${newData.error_description}`);
    }

    // 4. Update DB
    const newExpiresAt = new Date(Date.now() + newData.expires_in * 1000).toISOString();

    await supabaseAdmin
        .from('user_tokens')
        .update({
            access_token: newData.access_token,
            // Only update refresh token if a new one is returned (sometimes it isn't)
            refresh_token: newData.refresh_token || token.refresh_token,
            expires_at: newExpiresAt,
            updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('provider', 'spotify');

    return newData.access_token;
}

/**
 * Helper to get the first available User ID.
 * In a multi-user system, this would come from the context.
 */


export async function getPlaybackState(userId: string) {
    try {
        const token = await getAccessToken(userId);

        const response = await fetch('https://api.spotify.com/v1/me/player', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 204) return null; // No content = not playing

        const data = await response.json();
        return {
            is_playing: data.is_playing,
            track: data.item?.name,
            artist: data.item?.artists.map((a: any) => a.name).join(', '),
            album: data.item?.album?.name,
            device: data.device?.name,
            volume: data.device?.volume_percent
        };
    } catch (e: any) {
        console.error('[SpotifyService] Error fetching state:', e);
        return null;
    }
}

export async function searchAndPlay(userId: string, query: string, log: (msg: string) => void) {
    const token = await getAccessToken(userId);

    log(`[Spotify] Searching for "${query}"...`);

    // Search
    const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track,album,artist&limit=1`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const searchData = await searchRes.json();

    let uri = '';
    let name = '';
    let type = '';

    if (searchData.tracks?.items?.length) {
        uri = searchData.tracks.items[0].uri;
        name = `${searchData.tracks.items[0].name} by ${searchData.tracks.items[0].artists[0].name}`;
        type = 'track';
    } else if (searchData.albums?.items?.length) {
        uri = searchData.albums.items[0].uri;
        name = searchData.albums.items[0].name;
        type = 'album';
    } else if (searchData.artists?.items?.length) {
        uri = searchData.artists.items[0].uri;
        name = searchData.artists.items[0].name;
        type = 'artist';
    } else {
        throw new Error('No music found matching your request.');
    }

    log(`[Spotify] Found ${type}: "${name}". Playing...`);

    // Play
    const playBody: any = {};
    if (type === 'track') {
        playBody.uris = [uri];
    } else {
        playBody.context_uri = uri;
    }

    const playRes = await fetch('https://api.spotify.com/v1/me/player/play', {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(playBody)
    });

    if (playRes.status === 404) {
        throw new Error('No active device found. Open Spotify on a device first.');
    } else if (!playRes.ok) {
        const err = await playRes.json();
        throw new Error(`Spotify error: ${err.error?.message || playRes.statusText}`);
    }

    return `Playing "${name}" on Spotify.`;
}

export async function pause(userId: string) {
    const token = await getAccessToken(userId);
    await fetch('https://api.spotify.com/v1/me/player/pause', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    return 'Paused Spotify.';
}

export async function next(userId: string) {
    const token = await getAccessToken(userId);
    await fetch('https://api.spotify.com/v1/me/player/next', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    return 'Skipped to next track.';
}

export async function previous(userId: string) {
    const token = await getAccessToken(userId);
    await fetch('https://api.spotify.com/v1/me/player/previous', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    return 'Skipped to previous track.';
}
