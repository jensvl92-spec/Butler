import { supabase } from '../lib/supabase'
import { Browser } from '@capacitor/browser'

export async function signUp(email: string, password: string) {
  return supabase.auth.signUp({ email, password })
}

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password })
}

export async function signOut() {
  return supabase.auth.signOut()
}

export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser()
  return data?.user
}

export function onAuthStateChange(callback: (session: any) => void) {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session)
  })

  return subscription
}

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: 'butler://auth/callback',
      skipBrowserRedirect: true,
      scopes: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks',
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
      },
    },
  })

  if (data?.url) {
    await Browser.open({ url: data.url })
  }

  return { data, error }
}

export async function syncGoogleTokens(session: any, manualTokens?: { access_token: string; refresh_token?: string }) {
  const provider_token = manualTokens?.access_token || session?.provider_token;
  const provider_refresh_token = manualTokens?.refresh_token || session?.provider_refresh_token;

  if (!session?.provider_token && !provider_token) return;

  const { user } = session;

  // Only sync if we have a user and tokens
  if (!user || !provider_token) return;

  const expires_at = new Date(Date.now() + (session.expires_in || 3600) * 1000).toISOString();

  const updates: any = {
    user_id: user.id,
    provider: 'google',
    access_token: provider_token,
    expires_at,
    updated_at: new Date().toISOString()
  };

  if (provider_refresh_token) {
    updates.refresh_token = provider_refresh_token;
  }

  const { error } = await supabase
    .from('user_tokens')
    .upsert(updates, { onConflict: 'user_id,provider' });

  if (error) {
    console.error('❌ Failed to sync Google tokens to DB:', error);
  } else {
    console.log('✅ Google tokens sync complete');
  }
}
