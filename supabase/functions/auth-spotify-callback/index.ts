
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SPOTIFY_CLIENT_ID = Deno.env.get('SPOTIFY_CLIENT_ID') || '';
const SPOTIFY_CLIENT_SECRET = Deno.env.get('SPOTIFY_CLIENT_SECRET') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`Error: ${error}`, { status: 400 });
  }

  if (!code) {
    return new Response('No code provided', { status: 400 });
  }

  try {
    const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/auth-spotify-callback`;

    // Exchange code for tokens
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`)}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
      })
    });

    const tokens = await tokenResponse.json();

    if (tokens.error) {
      throw new Error(tokens.error_description || tokens.error);
    }

    // Initialize Supabase Admin client
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Hardcoded user ID for now (jensv), or extracted from state if we passed it.
    // Ideally, we'd pass the user_id in the 'state' param during init.
    // For now, let's assume single user mode or find the first user.

    // FETCH USER: We'll just grab the first user in the system for this Personal Assistant context
    const { data: users, error: userError } = await supabaseAdmin.auth.admin.listUsers();
    if (userError || !users.users.length) throw new Error('No user found to link account to');

    const userId = users.users[0].id; // Assign to the main admin user

    // Calculate expiry
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Store in DB
    const { error: dbError } = await supabaseAdmin
      .from('user_tokens')
      .upsert({
        user_id: userId,
        provider: 'spotify',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id, provider' });

    if (dbError) throw dbError;

    return new Response(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
          <h1 style="color: #1DB954;">Spotify Connected! 🎵</h1>
          <p>You can now close this window and ask your Personal Assistant to play music.</p>
        </body>
      </html>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });

  } catch (err: any) {
    return new Response(`Authentication failed: ${err.message}`, { status: 500 });
  }
});
