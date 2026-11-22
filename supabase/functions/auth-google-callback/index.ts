import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyOAuthState } from "../_shared/auth.ts";
import { fetchWithTimeout } from "../_shared/model-registry.ts";

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const stateParam = url.searchParams.get('state');

  if (error) {
    return new Response(`Error: ${error}`, { status: 400 });
  }
  if (!code) {
    return new Response('No authorization code provided', { status: 400 });
  }

  // Strictly verify HMAC-signed OAuth state (prevents CSRF & account takeover)
  const stateVerification = await verifyOAuthState(stateParam);
  if (!stateVerification.valid || !stateVerification.userId) {
    return new Response(`Invalid OAuth state: ${stateVerification.error || 'verification failed'}`, { status: 400 });
  }
  const userId = stateVerification.userId;

  try {
    const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/auth-google-callback`;

    const tokenResponse = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      })
    }, 15000);

    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || tokens.error) {
      throw new Error(tokens.error_description || tokens.error || `HTTP ${tokenResponse.status}`);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Verify target user exists
    const { data: userRecord, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (userErr || !userRecord?.user) {
      return new Response('Target user account not found.', { status: 404 });
    }

    const expiresAt = new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000);

    // Preserve existing refresh_token if Google omits it on re-authorization
    const upsertPayload: Record<string, any> = {
      user_id: userId,
      provider: 'google',
      access_token: tokens.access_token,
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString()
    };
    if (tokens.refresh_token) {
      upsertPayload.refresh_token = tokens.refresh_token;
    }

    const { error: dbError } = await supabaseAdmin
      .from('user_tokens')
      .upsert(upsertPayload, { onConflict: 'user_id,provider' });

    if (dbError) throw dbError;

    return new Response(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
          <h1 style="color: #4285F4;">Google Gekoppeld! 📅</h1>
          <p>Je kan dit venster nu sluiten en terugkeren naar Butler.</p>
        </body>
      </html>
    `, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });

  } catch (err: any) {
    return new Response(`Authentication failed: ${err.message}`, { status: 500 });
  }
});
