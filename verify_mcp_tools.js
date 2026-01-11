const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load .env manually to be sure
const envConfig = dotenv.parse(fs.readFileSync('.env'));
for (const k in envConfig) {
    process.env[k] = envConfig[k]
}

// Fallback to strict values if not in .env (though we rely on .env for security usually, 
// for this debug script we are in a secure user shell context)
// Note: We need the SERVICE ROLE KEY from supabase/functions files or dashboard
// Ideally read this from the environment or a config file.
// Assuming the user has a .env file or we can read it from the supabase/functions headers code (less ideal).

// Let's try to grab from process.env, but we might need to set them manually if they aren't loaded.
// For now, I'll rely on env variables being present or the user to run with them.
// Actually, I can read the .env file from the project root if it exists, or just hardcode the script to READ 
// the existing supabase/functions/.env file? No, that's not standard.

// Wait, the previous deno script used Deno.env.get.
// We are in the root of the project.
// Let's assume there is a .env file or try to find one.

// WARNING: Service Role Key is sensitive. I shouldn't hardcode it here if I can avoid it.
// I will attempt to read it from `supabase/.env` or ask `supabase status` if installed?
// Actually simpler: I will assume the key is in process.env or I will try to read 
// `supabase/functions/.env` if it exists (it usually doesn't).

// Strategy: I will check if I can just use the ANON key for public queries? 
// No, I need to check internal tables maybe?
// mcp_tools is likely protected.

// Alternative: Use the `supabase-js` client with the keys found in `src/lib/supabase.ts` (Anon Key) 
// but that won't work if RLS blocks reading mcp_tools.
// Wait, mcp_tools likely has RLS disabled or policy for authenticated users.
// The script runs locally.

// Let's try just listing rows with the ANON key first if we can find it.
// Better: I will use the values I saw in previous files (supabase.ts).

// For now, write a skeleton that FAILS fast if keys missing.
const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;

console.log('URL:', url);
console.log('Key (start):', key ? key.substring(0, 20) + '...' : 'MISSING');

if (!url || !key) {
    console.error("Please run with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY env vars.");
    // Don't exit, just let it fail if it must, but logging helps.
}

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(url, key);
const CONNECTION_ID = '64451e75-bd65-4e3a-92f3-576180d17cee';


async function main() {
    console.log(`Checking memory tools for connection: ${CONNECTION_ID}`);
    const { data: tools, error } = await supabase
        .from('mcp_tools')
        .select('name')
        .in('name', ['save_memory', 'search_memory', 'read_chat_history'])
        .or(`connection_id.eq.${CONNECTION_ID},connection_id.is.null`);

    if (error) {
        console.error('Error fetching tools:', error);
        return;
    }

    console.log(`Found ${tools.length} system tools:`, tools.map(t => t.name));

    const missing = ['save_memory', 'search_memory', 'read_chat_history'].filter(n => !tools.find(t => t.name === n));
    if (missing.length > 0) {
        console.error("❌ MISSING TOOLS:", missing);
    } else {
        console.log("✅ All memory tools present.");
    }
}

main();
