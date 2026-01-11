
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "https://deno.land/std@0.168.0/dotenv/load.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CONNECTION_ID = '64451e75-bd65-4e3a-92f3-576180d17cee';

async function main() {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    console.log(`🔍 Checking mcp_tools for Connection: ${CONNECTION_ID}`);

    // 1. Check Total Count
    const { count, error: countErr } = await supabase
        .from('mcp_tools')
        .select('*', { count: 'exact', head: true })
        .eq('connection_id', CONNECTION_ID);

    if (countErr) {
        console.error('❌ Check Failed:', countErr);
        return;
    }

    console.log(`📊 Total Tools Found: ${count}`);

    if (count === 0) {
        console.log('⚠️ No tools found implies sync failed on SERVER SIDE (Librarian).');
        return;
    }

    // 2. Check Embedding Status
    // We check how many rows have a NULL embedding
    const { count: nullEmbeddings, error: embErr } = await supabase
        .from('mcp_tools')
        .select('*', { count: 'exact', head: true })
        .eq('connection_id', CONNECTION_ID)
        .is('embedding', null);

    if (embErr) {
        console.error('❌ Embedding Check Failed:', embErr);
        return;
    }

    console.log(`🧠 Tools WITHOUT Embeddings: ${nullEmbeddings}`);
    console.log(`✅ Tools WITH Embeddings: ${count! - (nullEmbeddings || 0)}`);

    if (nullEmbeddings === count) {
        console.log('⚠️ ALL tools are missing embeddings. This explains why search returns 0.');
        console.log('   The "update_embedding" trigger or function might be failing.');
    } else if (nullEmbeddings! > 0) {
        console.log('⚠️ Some embeddings are missing. Background processing lagging?');
    } else {
        console.log('✅ Data looks healthy. Issue might be query logic (mcp-proxy).');

        // Test Search
        console.log('\n🧪 Testing Semantic Search (Simulated)...');
    }
}

main();
