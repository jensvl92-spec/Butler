
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SPOTIFY_CLIENT_ID = Deno.env.get('SPOTIFY_CLIENT_ID') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';

// Scopes for Spotify
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played'
].join(' ');

serve(async (req) => {
  const url = new URL(req.url);

  // Dynamic redirect URI based on where the function is running
  const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/auth-spotify-callback`;

  // Generate random state for security
  const state = crypto.randomUUID();

  // Construct Auth URL
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state: state,
  });

  const spotifyAuthUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;

  // Redirect user
  return new Response(null, {
    status: 302,
    headers: {
      'Location': spotifyAuthUrl,
    },
  });
});
