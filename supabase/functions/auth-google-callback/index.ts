
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
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
    const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/auth-google-callback`;

    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      })
    });

    const tokens = await tokenResponse.json();

    if (tokens.error) {
      throw new Error(tokens.error_description || tokens.error);
    }

    // Initialize Supabase Admin client
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // FETCH USER
    const { data: users, error: userError } = await supabaseAdmin.auth.admin.listUsers();
    if (userError || !users.users.length) throw new Error('No user found');
    const userId = users.users[0].id;

    // Calculate expiry
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Store in DB
    const { error: dbError } = await supabaseAdmin
      .from('user_tokens')
      .upsert({
        user_id: userId,
        provider: 'google',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token, // Might be null if not requesting offline/consent
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id, provider' });

    if (dbError) throw dbError;

    return new Response(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
          <h1 style="color: #4285F4;">Google Calendar Connected! 📅</h1>
          <p>You can now ask your Personal Assistant about your schedule.</p>
        </body>
      </html>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });

  } catch (err: any) {
    return new Response(`Authentication failed: ${err.message}`, { status: 500 });
  }
});
