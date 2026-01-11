
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
 * Get a valid access token.
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

    if (error || !tokenData) throw new Error('Google account not connected.');

    const token = tokenData as GoogleToken;
    const expiresAt = new Date(token.expires_at).getTime();
    if (expiresAt > Date.now() + 5 * 60 * 1000) return token.access_token;

    // Refresh
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
    const newExpiresAt = new Date(Date.now() + newData.expires_in * 1000).toISOString();

    await supabaseAdmin
        .from('user_tokens')
        .update({ access_token: newData.access_token, expires_at: newExpiresAt })
        .eq('user_id', userId).eq('provider', 'google');

    return newData.access_token;
}



/**
 * Search for music on YouTube.
 */
export async function searchYouTubeMusic(userId: string, query: string, log: (msg: string) => void = () => { }) {
    try {
        log(`[YouTubeService] Searching for "${query}"...`);
        const token = await getAccessToken(userId);

        // Loosen search by removing videoCategoryId=10 and adding "music" if needed
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=3`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (data.error) {
            log(`[YouTubeService] API Error: ${data.error.message}`);
            return [];
        }

        if (!data.items || data.items.length === 0) {
            log(`[YouTubeService] No results found for query: "${query}"`);
            log(`[YouTubeService] Full Response: ${JSON.stringify(data).substring(0, 200)}...`);
            return [];
        }

        log(`[YouTubeService] Found ${data.items.length} items.`);
        return data.items.map((video: any) => ({
            title: video.snippet.title,
            videoId: video.id.videoId,
            url: `https://music.youtube.com/watch?v=${video.id.videoId}`,
            appLink: `youtube-music://watch?v=${video.id.videoId}`
        }));
    } catch (e: any) {
        log(`[YouTubeService] Exception: ${e.message}`);
        console.error('[YouTubeService] Error:', e);
        return [];
    }
}
