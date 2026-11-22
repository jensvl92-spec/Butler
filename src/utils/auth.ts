import { supabase } from '../lib/supabase'
import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'

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
  } = supabase.auth.onAuthStateChange((_event: any, session: any) => {
    callback(session)
  })

  return subscription
}

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/youtube.readonly'
].join(' ')

export async function signInWithGoogle() {
  const isNative = Capacitor.isNativePlatform()
  const redirectTo = isNative ? 'butler://auth/callback' : window.location.origin

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      skipBrowserRedirect: isNative,
      scopes: GOOGLE_SCOPES,
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
      },
    },
  })

  if (isNative && data?.url) {
    await Browser.open({ url: data.url })
  }

  return { data, error }
}

export async function syncGoogleTokens(
  session: any,
  manualTokens?: { access_token: string; refresh_token?: string; expires_in?: number }
): Promise<{ success: boolean; error?: string }> {
  const provider_token = manualTokens?.access_token || session?.provider_token
  const provider_refresh_token = manualTokens?.refresh_token || session?.provider_refresh_token

  if (!provider_token) {
    return { success: false, error: 'Geen provider token beschikbaar.' }
  }

  let userId = session?.user?.id
  if (!userId) {
    const { data } = await supabase.auth.getUser()
    userId = data?.user?.id
  }

  if (!userId) {
    return { success: false, error: 'Geen ingelogde gebruiker gevonden.' }
  }

  // Google access tokens expire in ~3600s from issuance
  const ttlSeconds = manualTokens?.expires_in || 3500
  const expires_at = new Date(Date.now() + ttlSeconds * 1000).toISOString()

  const updates: Record<string, any> = {
    user_id: userId,
    provider: 'google',
    access_token: provider_token,
    expires_at,
    updated_at: new Date().toISOString()
  }

  // Only overwrite refresh_token when a non-empty refresh token is actually returned
  if (provider_refresh_token) {
    updates.refresh_token = provider_refresh_token
  }

  const { error } = await supabase
    .from('user_tokens')
    .upsert(updates, { onConflict: 'user_id,provider' })

  if (error) {
    console.error('❌ Failed to sync Google tokens to DB:', error)
    return { success: false, error: error.message }
  }

  console.log('✅ Google tokens sync complete')
  return { success: true }
}
