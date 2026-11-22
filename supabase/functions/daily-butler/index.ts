import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from '../_shared/auth.ts';
import { fetchHAStates, syncScriptsToDB } from '../_shared/ha-api.ts';
import { chatCompletion } from '../_shared/llm-service.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
    }

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) {
            return new Response(JSON.stringify({ error: auth.error }), {
                status: auth.status || 401,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        const now = new Date();
        const currentHour = now.getHours();
        let mode = (currentHour >= 20 || currentHour < 5) ? "night_watch" : "morning_briefing";

        const rawBody = await req.text().catch(() => '');
        const payload = rawBody ? JSON.parse(rawBody) : {};
        if (payload.mode) mode = payload.mode;
        const requestedConnectionId: string | undefined = payload.connection_id;

        console.log(`🕒 Daily Butler running in mode: ${mode}`);

        // Resolve target connections with strict tenant scoping
        let connections: any[] = [];
        if (requestedConnectionId) {
            const ownership = await verifyConnectionOwnership(supabase, auth, requestedConnectionId);
            if (!ownership.valid) {
                return new Response(JSON.stringify({ error: ownership.error }), {
                    status: ownership.status || 403,
                    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
                });
            }
            connections = [ownership.connection];
        } else if (auth.isServiceOrCron) {
            const { data } = await supabase.from('ha_connections').select('*');
            connections = data || [];
        } else if (auth.userId) {
            const { data } = await supabase.from('ha_connections').select('*').eq('user_id', auth.userId);
            connections = data || [];
        }

        if (connections.length === 0) {
            return new Response(JSON.stringify({ message: "Geen actieve koppelingen gevonden", results: [] }), {
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        const results: any[] = [];

        for (const conn of connections) {
            if (!conn.api_url || !conn.api_token) {
                results.push({ id: conn.id, status: "skipped", reason: "Missing HA credentials" });
                continue;
            }

            try {
                await syncScriptsToDB(conn, supabase);
                const allStates = await fetchHAStates(conn);

                const relevantDomains = ["weather", "person", "climate", "lock", "cover", "binary_sensor"];
                const relevantStates = allStates
                    .filter((e: any) => relevantDomains.includes((e.entity_id || '').split('.')[0]))
                    .slice(0, 120);

                const stateSummary = relevantStates
                    .map((e: any) => `${e.entity_id}: ${e.state}${e.attributes?.friendly_name ? ` (${e.attributes.friendly_name})` : ''}`)
                    .join('\n');

                const systemPrompt = mode === "morning_briefing"
                    ? `Je bent Butler, een attente persoonlijke smart-home assistent. Het is ochtend.
Geef een korte, heldere ochtendbriefing in het Nederlands (max 45 woorden):
1. Begroet vriendelijk.
2. Vat weer, aanwezigheid en eventuele opvallende zaken samen.
3. Sluit af met een korte vraag naar de plannen voor vandaag.`
                    : `Je bent Butler, een waakzame nachtwacht voor een smart home. Het is avond/nacht.
Geef een korte veiligheidscheck in het Nederlands (max 45 woorden):
1. Meld de status van sloten, deuren, ramen en zonwering/rolluiken.
2. Geef aan of iedereen thuis is.
3. Wijs op openstaande deuren/ramen of ontgrendelde sloten en wens een goede nacht.`;

                const content = await chatCompletion([
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Actuele woningstatus:\n${stateSummary || 'Geen sensordata beschikbaar.'}` }
                ], 250, 0.4, undefined, undefined, undefined, { effort: 'low' }, 'high_accuracy');

                if (content) {
                    let pushSent = false;
                    if (conn.fcm_token) {
                        const { sendFCM } = await import("../_shared/firebase.ts");
                        await sendFCM(
                            conn.fcm_token,
                            mode === "morning_briefing" ? "🌅 Ochtendbriefing" : "🛡️ Nachtronde",
                            content,
                            mode === "morning_briefing" ? "PLAN_REQUEST" : "NIGHT_WATCH"
                        );
                        pushSent = true;
                    }
                    results.push({ id: conn.id, status: "ok", pushSent, content });
                }
            } catch (err: any) {
                console.error(`Error processing connection ${conn.id}:`, err);
                results.push({ id: conn.id, status: "error", error: err?.message || String(err) });
            }
        }

        const firstContent = results.find(r => r.content)?.content;
        return new Response(JSON.stringify({
            success: true,
            mode,
            message: firstContent || `Daily Butler (${mode}) voltooid voor ${results.length} koppeling(en).`,
            results
        }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });

    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
    }
});
