/**
 * Workspace Bridge - Supabase Edge Function
 * Secure server-side OAuth token refresh for Google Workspace & Spotify.
 * Uses server-side GOOGLE_CLIENT_SECRET / SPOTIFY_CLIENT_SECRET so secrets never touch the client.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRequestAuth, CORS_HEADERS } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
const SPOTIFY_CLIENT_ID = Deno.env.get("SPOTIFY_CLIENT_ID") || "";
const SPOTIFY_CLIENT_SECRET = Deno.env.get("SPOTIFY_CLIENT_SECRET") || "";

function json(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const auth = await verifyRequestAuth(req);
    if (!auth.authenticated || !auth.userId) {
        return json({ error: auth.error || "Unauthorized" }, 401);
    }

    try {
        const body = await req.json();
        const provider = body?.provider === "spotify" ? "spotify" : "google";
        const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        const { data: tokenRow, error } = await supabaseAdmin
            .from("user_tokens")
            .select("access_token, refresh_token, expires_at")
            .eq("user_id", auth.userId)
            .eq("provider", provider)
            .single();

        if (error || !tokenRow?.refresh_token) {
            return json({ error: `Geen refresh token gevonden voor ${provider}.` }, 404);
        }

        let newAccessToken = "";
        let newRefreshToken = tokenRow.refresh_token;
        let expiresIn = 3500;

        if (provider === "google") {
            if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
                return json({ error: "GOOGLE_CLIENT_ID/SECRET niet geconfigureerd op backend." }, 500);
            }
            const res = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: tokenRow.refresh_token,
                    client_id: GOOGLE_CLIENT_ID,
                    client_secret: GOOGLE_CLIENT_SECRET
                })
            });
            const data = await res.json();
            if (data.error || !data.access_token) {
                return json({ error: data.error_description || data.error || "Google refresh failed" }, 400);
            }
            newAccessToken = data.access_token;
            expiresIn = Number(data.expires_in) || 3500;
        } else {
            if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
                return json({ error: "SPOTIFY_CLIENT_ID/SECRET niet geconfigureerd op backend." }, 500);
            }
            const res = await fetch("https://accounts.spotify.com/api/token", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Authorization: `Basic ${btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`)}`
                },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: tokenRow.refresh_token
                })
            });
            const data = await res.json();
            if (data.error || !data.access_token) {
                return json({ error: data.error_description || data.error || "Spotify refresh failed" }, 400);
            }
            newAccessToken = data.access_token;
            if (data.refresh_token) newRefreshToken = data.refresh_token;
            expiresIn = Number(data.expires_in) || 3500;
        }

        const newExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        await supabaseAdmin
            .from("user_tokens")
            .update({
                access_token: newAccessToken,
                refresh_token: newRefreshToken,
                expires_at: newExpiresAt,
                updated_at: new Date().toISOString()
            })
            .eq("user_id", auth.userId)
            .eq("provider", provider);

        return json({ access_token: newAccessToken, expires_at: newExpiresAt });
    } catch (e: any) {
        return json({ error: e?.message || "Internal error" }, 500);
    }
});
