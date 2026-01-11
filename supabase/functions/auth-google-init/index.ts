
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';

// Scopes for Google APIs
// NOTE: Google Keep API is enterprise-only, using Tasks API instead for note/task functionality
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.readonly',  // For listing files
  'https://www.googleapis.com/auth/tasks'  // For task management (alternative to Keep)
].join(' ');

serve(async (req) => {
  const url = new URL(req.url);

  // Dynamic redirect URI based on where the function is running
  const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/auth-google-callback`;

  // Generate random state for security
  const state = crypto.randomUUID();

  // Construct Auth URL
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state: state,
    access_type: 'offline', // CRITICAL for refresh tokens
    prompt: 'consent',     // Force consent to ensure we get refresh token
  });

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // Redirect user
  return new Response(null, {
    status: 302,
    headers: {
      'Location': googleAuthUrl,
    },
  });
});
