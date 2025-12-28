
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// @ts-ignore
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
// @ts-ignore
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

serve(async (req: Request) => {
    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

        const results: any = { columns_found: [], type_test_string: null, type_test_object: null };

        // 1. Get Schema via Row Inspection
        const { data: rows, error: readError } = await supabase.from('chat_history').select('*').limit(1);
        if (rows && rows.length > 0) {
            results.columns_found = Object.keys(rows[0]);
            results.sample_row = rows[0];
        } else {
            results.columns_found = "No rows to inspect or Read Failed: " + (readError?.message || "Empty");
        }

        // 2. Get Connection ID
        const { data: conn } = await supabase.from('ha_connections').select('id').limit(1).single();

        if (conn) {
            const basePayload = {
                connection_id: conn.id,
                user_message: "DEBUG_TYPE_TEST",
                actions_taken: [],
                metadata: {}
            };

            // Test A: String
            // @ts-ignore
            const payloadStr = { ...basePayload, ai_response: JSON.stringify({ text: "String Test" }) };
            const { error: errStr } = await supabase.from('chat_history').insert(payloadStr);
            results.type_test_string = errStr ? errStr : "SUCCESS";

            // Test B: Object
            // @ts-ignore
            const payloadObj = { ...basePayload, ai_response: { text: "Object Test" } };
            const { error: errObj } = await supabase.from('chat_history').insert(payloadObj);
            results.type_test_object = errObj ? errObj : "SUCCESS";
        }

        return new Response(JSON.stringify(results, null, 2), {
            headers: { "Content-Type": "application/json" }
        })
    } catch (error: any) {
        return new Response(JSON.stringify({ fatal_error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        })
    }
})
