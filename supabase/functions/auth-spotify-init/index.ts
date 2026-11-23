import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { signOAuthState, CORS_HEADERS } from "../_shared/auth.ts";

const SPOTIFY_CLIENT_ID = Deno.env.get('SPOTIFY_CLIENT_ID') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played'
].join(' ');

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  const url = new URL(req.url);
  const authHeader = (req.headers.get('Authorization') || '').trim();
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : (url.searchParams.get('access_token') || '').trim();

  if (!token) {
    return new Response('Unauthorized: user access_token required to start Spotify OAuth flow.', { status: 401 });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) {
    return new Response('Unauthorized: invalid or expired session token.', { status: 401 });
  }

  if (!SPOTIFY_CLIENT_ID) {
    return new Response(JSON.stringify({ error: 'SPOTIFY_CLIENT_ID secret is not configured in Supabase.' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  const state = await signOAuthState(data.user.id);
  const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/auth-spotify-callback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });

  const authorizeUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({ url: authorizeUrl }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  return new Response(null, {
    status: 302,
    headers: { ...CORS_HEADERS, 'Location': authorizeUrl },
  });
});
