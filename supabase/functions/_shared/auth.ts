/**
 * Shared Authentication, Authorization & OAuth State Security Helpers
 *
 * Used by all Supabase Edge Functions to enforce:
 * 1. Real user JWT verification (rejects anonymous/public anon_key calls on protected endpoints).
 * 2. Strict tenant ownership verification (`ha_connections.user_id === user.id`).
 * 3. Internal cron / service-role authentication via `CRON_SECRET` or exact `SUPABASE_SERVICE_ROLE_KEY`.
 * 4. HMAC-SHA256 signed OAuth state parameters (prevents CSRF & account takeover).
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface AuthResult {
    authorized: boolean;
    isServiceOrCron: boolean;
    userId?: string;
    error?: string;
    status?: number;
}

export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

/**
 * Verifies caller identity from Request headers.
 * - Accepts `x-cron-secret` matching `CRON_SECRET` env var (if set)
 * - Accepts `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` for internal cron/service invocations
 * - Otherwise verifies the Bearer token as a real Supabase User JWT via `supabaseAdmin.auth.getUser(token)`
 *   (NOTE: The public anon_key fails `auth.getUser()` and is therefore rejected!)
 */
export async function verifyRequestAuth(
    req: Request,
    supabaseAdmin: SupabaseClient,
    options: { allowServiceOrCron?: boolean; requireServiceOrCron?: boolean } = {}
): Promise<AuthResult> {
    const allowServiceOrCron = options.allowServiceOrCron ?? true;
    const requireServiceOrCron = options.requireServiceOrCron ?? false;

    const cronSecretEnv = (Deno.env.get('CRON_SECRET') || '').trim();
    const serviceRoleEnv = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();

    const cronHeader = (req.headers.get('x-cron-secret') || '').trim();
    const authHeader = (req.headers.get('Authorization') || '').trim();
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';

    // 1. Check Cron Secret or exact Service Role Key
    if (allowServiceOrCron) {
        if (cronSecretEnv && cronHeader && timingSafeEqual(cronHeader, cronSecretEnv)) {
            return { authorized: true, isServiceOrCron: true };
        }
        if (serviceRoleEnv && bearerToken && timingSafeEqual(bearerToken, serviceRoleEnv)) {
            return { authorized: true, isServiceOrCron: true };
        }
    }

    if (requireServiceOrCron) {
        return {
            authorized: false,
            isServiceOrCron: false,
            status: 401,
            error: 'Unauthorized: service or cron credentials required.'
        };
    }

    if (!bearerToken) {
        return {
            authorized: false,
            isServiceOrCron: false,
            status: 401,
            error: 'Missing Authorization Bearer token.'
        };
    }

    // 2. Verify User JWT (anon key has no user and fails here!)
    try {
        const { data, error } = await supabaseAdmin.auth.getUser(bearerToken);
        if (error || !data?.user?.id) {
            return {
                authorized: false,
                isServiceOrCron: false,
                status: 401,
                error: 'Invalid or expired user session token.'
            };
        }
        return {
            authorized: true,
            isServiceOrCron: false,
            userId: data.user.id
        };
    } catch {
        return {
            authorized: false,
            isServiceOrCron: false,
            status: 401,
            error: 'Token verification failed.'
        };
    }
}

/**
 * Verifies that the authenticated user owns the requested `connection_id`.
 * Service/cron callers bypass per-user ownership check.
 */
export async function verifyConnectionOwnership(
    supabaseAdmin: SupabaseClient,
    auth: AuthResult,
    connectionId: string
): Promise<{ valid: boolean; connection?: any; error?: string; status?: number }> {
    if (!connectionId || !/^[0-9a-f-]{36}$/i.test(connectionId)) {
        return { valid: false, status: 400, error: 'Invalid connection_id format.' };
    }

    const { data: conn, error } = await supabaseAdmin
        .from('ha_connections')
        .select('*')
        .eq('id', connectionId)
        .single();

    if (error || !conn) {
        return { valid: false, status: 404, error: 'Connection not found.' };
    }

    if (!auth.isServiceOrCron && conn.user_id !== auth.userId) {
        return { valid: false, status: 403, error: 'Forbidden: connection does not belong to user.' };
    }

    return { valid: true, connection: conn };
}

/**
 * HMAC-SHA256 OAuth State Signing & Verification (15-minute TTL).
 */
async function hmacSign(payload: string, secret: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
    return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function getOAuthStateSecret(): string {
    return (
        Deno.env.get('OAUTH_STATE_SECRET') ||
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
        ''
    );
}

export async function signOAuthState(userId: string): Promise<string> {
    const secret = getOAuthStateSecret();
    if (!secret) throw new Error('Missing server secret for OAuth state signing');
    const ts = Date.now().toString();
    const nonce = crypto.randomUUID();
    const payload = `${userId}.${ts}.${nonce}`;
    const sig = await hmacSign(payload, secret);
    return `${payload}.${sig}`;
}

export async function verifyOAuthState(
    state: string | null,
    maxAgeMs: number = 15 * 60 * 1000
): Promise<{ valid: boolean; userId?: string; error?: string }> {
    if (!state) return { valid: false, error: 'Missing OAuth state parameter.' };
    const secret = getOAuthStateSecret();
    if (!secret) return { valid: false, error: 'Missing server secret.' };

    const parts = state.split('.');
    if (parts.length !== 4) {
        return { valid: false, error: 'Malformed OAuth state.' };
    }

    const [userId, tsStr, nonce, providedSig] = parts;
    const ts = Number(tsStr);
    if (!userId || !Number.isFinite(ts) || !nonce || !providedSig) {
        return { valid: false, error: 'Invalid OAuth state fields.' };
    }

    if (Math.abs(Date.now() - ts) > maxAgeMs) {
        return { valid: false, error: 'OAuth state expired. Please retry.' };
    }

    const expectedSig = await hmacSign(`${userId}.${tsStr}.${nonce}`, secret);
    if (!timingSafeEqual(expectedSig, providedSig)) {
        return { valid: false, error: 'Invalid OAuth state signature.' };
    }

    return { valid: true, userId };
}

/**
 * Validates that a URL is an HTTP(S) URL and does not target cloud metadata / loopback SSRF endpoints.
 */
export function isSafeExternalUrl(rawUrl: string): boolean {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        // Block cloud metadata & loopback
        if (
            host === 'localhost' ||
            host === '127.0.0.1' ||
            host === '::1' ||
            host === '0.0.0.0' ||
            host === '169.254.169.254' ||
            host === 'metadata.google.internal' ||
            host.startsWith('169.254.')
        ) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}
