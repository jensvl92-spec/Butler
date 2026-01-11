
const fs = require('fs');
const dotenv = require('dotenv');

// Load .env
const envConfig = dotenv.parse(fs.readFileSync('.env'));
for (const k in envConfig) process.env[k] = envConfig[k];

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;
const PROXY_URL = `${url}/functions/v1/mcp-proxy`;

async function testSearch() {
    console.log(`Testing Search at: ${PROXY_URL}/tools/search`);

    // Dummy embedding (1536 zeros) - just to check if query runs
    // Ideally we'd use a real embedding but all-zeros should at least returned SOMETHING if tools exist
    // or we can just rely on the migration logic.
    // Actually, dot product with zeros is 0. Distance is 1. Similarity is 0.
    // Threshold is 0.3. So Zeros won't match anything.

    // We need a non-zero vector. Let's make a random unit vector?
    // Or simpler: The query logic in SQL is: 1 - (embedding <=> query) > threshold.
    // If I send a random vector, I might not match anything.

    // BETTER IDEA: Use the `verify_mcp_tools.js` to get a REAL embedding from the DB and query with THAT.
    // That guarantees a match (similarity = 1.0).

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(url, key);
    const CONNECTION_ID = '64451e75-bd65-4e3a-92f3-576180d17cee';

    const { data } = await supabase.from('mcp_tools')
        .select('embedding')
        .eq('connection_id', CONNECTION_ID)
        .not('embedding', 'is', null)
        .limit(1);

    if (!data || data.length === 0) {
        console.error("No embeddings found to test with.");
        return;
    }

    const testEmbedding = JSON.parse(data[0].embedding);
    console.log("Got reference embedding. Querying proxy...");

    const resp = await fetch(`${PROXY_URL}/tools/search`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
            query_embedding: testEmbedding,
            connection_id: CONNECTION_ID,
            limit: 5
        })
    });

    if (!resp.ok) {
        console.error("Search Failed:", resp.status, await resp.text());
        return;
    }

    const json = await resp.json();
    console.log("Search Result Tools:", (json.tools || []).length);
    if (json.tools && json.tools.length > 0) {
        console.log("First match:", json.tools[0].name);
    }
}

testSearch();
