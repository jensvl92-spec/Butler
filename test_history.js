
const fs = require('fs');
const dotenv = require('dotenv');

// Load .env
const envConfig = dotenv.parse(fs.readFileSync('.env'));
for (const k in envConfig) process.env[k] = envConfig[k];

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;
// NOTE: We need SERVICE_ROLE_KEY to write to chat_history effectively if RLS is tight?
// Actually, chat_history usually has RLS enabling insert for authenticated users, but maybe not Anon.
// But `process-ai-command` uses SERVICE_ROLE.
// I can only test READ properties with ANON if RLS allows it.
// If RLS allows "select own rows", I need a user token.
// OR, I need the SERVICE_ROLE_KEY to mimic the Edge Function.
// I don't have the SERVICE_ROLE_KEY in .env (usually). 
// Wait, I might have seen it in `supabase/functions/.env`? No, I can't see that.
// BUT, I can try with ANON first. If it fails, I know RLS is active.

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(url, key);
const CONNECTION_ID = '64451e75-bd65-4e3a-92f3-576180d17cee';

async function testHistory() {
    console.log("Testing Chat History...");

    // 1. Try to Read History (Anon)
    const { data, error } = await supabase
        .from('chat_history')
        .select('*')
        .eq('connection_id', CONNECTION_ID)
        .limit(5);

    if (error) {
        console.error("Read Failed (Anon):", error);
    } else {
        console.log(`Read Success (Anon). Found ${data.length} rows.`);
        if (data.length > 0) {
            console.log("Sample:", data[0].user_message, "->", data[0].ai_response);
        }
    }
}

testHistory();
