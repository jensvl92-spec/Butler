import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { signOAuthState, CORS_HEADERS } from "../_shared/auth.ts";

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/tasks'
].join(' ');

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  const url = new URL(req.url);
  const authHeader = (req.headers.get('Authorization') || '').trim();
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : (url.searchParams.get('access_token') || '').trim();

  if (!token) {
    return new Response('Unauthorized: user access_token required to start OAuth flow.', { status: 401 });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) {
    return new Response('Unauthorized: invalid or expired session token.', { status: 401 });
  }

  const state = await signOAuthState(data.user.id);
  const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/auth-google-callback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return new Response(null, {
    status: 302,
    headers: { 'Location': `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` },
  });
});
