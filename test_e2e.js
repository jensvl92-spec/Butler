const https = require('https');

const HOST = 'rbriqijzyptjwsjrsqvc.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJicmlxaWp6eXB0andzanJzcXZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyMjY3MDgsImV4cCI6MjA4MDgwMjcwOH0.94wS30fbBgNXqtO4zqTAFPa7XVs7CEaegAwVu6nMk40';
const HEADERS = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${KEY}`
};

function request(path, method, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: HOST,
            path: `/functions/v1${path}`,
            method: method,
            headers: { ...HEADERS }
        };

        if (body) {
            const data = JSON.stringify(body);
            options.headers['Content-Length'] = data.length;
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
        } else {
            const req = https.request(options, res => {
                let chunks = [];
                res.on('data', d => chunks.push(d));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString();
                    resolve({ status: res.statusCode, body: body });
                });
            });
            req.on('error', reject);
            req.end();
        }
    });
}

async function run() {
    console.log('--- START E2E TEST ---');

    // 1. Check existing tools (expect defaults from migration)
    try {
        console.log('\n1. Checking mcp-proxy/tools (Initial)...');
        const res1 = await request('/mcp-proxy/tools', 'GET');
        console.log('Status:', res1.status);
        const tools1 = JSON.parse(res1.body).tools || [];
        console.log('Tool count:', tools1.length);
        const hasDefaults = tools1.some(t => t.name === 'get_lights');
        console.log('Has default "get_lights":', hasDefaults);

        if (!hasDefaults) {
            console.error('FAIL: Default tools missing! Migration might have failed.');
        }
    } catch (e) {
        console.error('Error fetching tools:', e);
    }

    // 2. Sync a new tool
    const TEST_ID = 'e2e-check-' + Date.now();
    try {
        console.log(`\n2. Syncing test tool via mcp-librarian... (ID: ${TEST_ID})`);
        const syncPayload = {
            connection_id: TEST_ID,
            entities: [
                { entity_id: 'light.e2e_verifier', state: 'on', attributes: { friendly_name: 'Verifier Light' } }
            ],
            services: {
                light: {
                    turn_on: { name: 'Verification Turn On', info: { description: 'Verifying sync works' } }
                }
            }
        };
        const res2 = await request('/mcp-librarian/sync', 'POST', syncPayload);
        console.log('Status:', res2.status);
        console.log('Body:', res2.body);
    } catch (e) {
        console.error('Error syncing:', e);
    }

    // 3. CheckProxy again
    try {
        console.log('\n3. Checking mcp-proxy/tools (After Sync)...');
        const res3 = await request('/mcp-proxy/tools', 'GET');
        const tools3 = JSON.parse(res3.body).tools || [];
        console.log('Tool count:', tools3.length);
        const found = tools3.find(t => t.name.includes('light.turn_on') && t.description.includes('Verifying'));
        // Note: Name might be formatted by Librarian. Basic fallback is name=Verification Turn On? 
        // Librarian basicFormat uses name=service.name.
        // Let's check for any tool with our connection? 
        // Proxy doesn't filter by connection yet (based on my read), so checking count increase or specific item.
        // Actually, basicFormat name = service.name = 'Verification Turn On'.

        console.log('Found new tool:', !!found);
        if (found) console.log('New Tool:', found.name);
    } catch (e) {
        console.error('Error fetching tools:', e);
    }

    console.log('\n--- END E2E TEST ---');
}

run();
