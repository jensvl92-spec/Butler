// analyze-patterns/index.ts
// The "Weekly Consultant" Cron Job.
// Uses _shared/pattern-engine.ts to find habits.
// Sends a "Sunday Report" via Notification.

// @ts-ignore
import { createClient } from "npm:@supabase/supabase-js@2.38.4"
import { PatternEngine } from '../_shared/pattern-engine.ts'

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

// @ts-ignore
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
// @ts-ignore
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

// @ts-ignore
Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        const engine = new PatternEngine();

        // 1. Get Connections & Check for On-Demand trigger
        let targetConnectionId: string | null = null;
        try {
            const body = await req.json();
            if (body && body.connection_id) targetConnectionId = body.connection_id;
        } catch (e) {
            // Body is optional (Cron trigger has no body or empty body)
        }

        let query = supabase.from('ha_connections').select('id, api_url, api_token, fcm_token');
        if (targetConnectionId) {
            query = query.eq('id', targetConnectionId);
        }

        const { data: connections } = await query;

        console.log(`🔍 Starting Scan. Mode: ${targetConnectionId ? 'ON-DEMAND' : 'CRON'}. Targets: ${connections?.length || 0}`);

        if (!connections || connections.length === 0) {
            return new Response(JSON.stringify({ message: "No connections found" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
        }

        let totalPatterns = 0;

        for (const conn of connections) {
            console.log(`🔍 Scanning ${conn.id}...`);

            // 2. Scan History
            const patterns = await engine.scanConnection(conn, 7); // 7 Days for weekly report

            if (patterns.length > 0) {
                totalPatterns += patterns.length;

                // 3. Save & Notify
                for (const p of patterns) {
                    await supabase.from('suggestions').insert({
                        title: `Pattern: ${p.title}`,
                        description: p.description,
                        actions: [{ type: "create_automation", data: p.ha_automation_data }],
                        confidence: p.confidence,
                        status: 'pending',
                        type: 'weekly_pattern'
                    });
                }

                // Notify User
                if (conn.fcm_token) {
                    const { sendFCM } = await import("../_shared/firebase.ts");
                    const title = `Weekly Report: ${patterns.length} New Ideas`;
                    const body = `I found ${patterns.length} potential automations based on your habits. Tap to review.`;
                    await sendFCM(conn.fcm_token, title, body);
                }
            }
        }

        return new Response(JSON.stringify({ success: true, patternsFound: totalPatterns }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        })

    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
    }
})
