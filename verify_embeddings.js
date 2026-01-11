const https = require('https');

const HOST = 'rbriqijzyptjwsjrsqvc.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJicmlxaWp6eXB0andzanJzcXZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyMjY3MDgsImV4cCI6MjA4MDgwMjcwOH0.94wS30fbBgNXqtO4zqTAFPa7XVs7CEaegAwVu6nMk40';
const HEADERS = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${KEY}`
};

function post(path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const options = {
            hostname: HOST,
            path: `/functions/v1${path}`,
            method: 'POST',
            headers: {
                ...HEADERS,
                'Content-Length': data.length
            }
        };

        const req = https.request(options, res => {
            let chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                resolve({ status: res.statusCode, body: body });
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function runTest() {
    console.log('--- START EMBEDDING VERIFICATION ---');

    // 1. Sync a unique tool to generate an embedding
    const TEST_CONN = '00000000-0000-0000-0000-000000000001';
    console.log(`\n1. Syncing unique tool via Librarian... (Conn: ${TEST_CONN})`);
    const syncPayload = {
        connection_id: TEST_CONN,
        entities: [
            { entity_id: 'light.galaxy_nebula', state: 'on', attributes: { friendly_name: 'Galaxy Nebula Mood Light' } }
        ],
        services: {
            light: {
                turn_on: { name: 'Cosmic Glow', info: { description: 'Fills the room with a deep space nebula effect' } }
            }
        }
    };

    const res1 = await post('/mcp-librarian/sync', syncPayload);
    console.log('Sync Status:', res1.status);
    console.log('Sync Response:', res1.body);

    if (res1.status !== 200) {
        console.error('FAIL: Sync failed.');
        return;
    }

    // 2. Wait a moment for DB commit
    await new Promise(r => setTimeout(r, 2000));

    // 3. Verify tool retrieval by name + connection
    console.log('\n2. Verifying tool exists in DB...');
    const res2 = await fetch(`https://${HOST}/functions/v1/mcp-librarian/tools?connection_id=${TEST_CONN}`, { headers: HEADERS });
    const { tools } = await res2.json();
    const myTool = (tools || []).find(t => t.name.includes('light.Galaxy')); // Name might be formatted

    if (myTool) {
        console.log('Found tool:', myTool.name);
        // Note: We can't easily see the embedding via this API without adding it to select
        // but we can test if it's searchable.
    } else {
        console.error('FAIL: Tool not found in search.');
        console.log('Tools found:', (tools || []).map(t => t.name));
    }

    console.log('\n--- END EMBEDDING VERIFICATION ---');
}

runTest();
