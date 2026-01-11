/**
 * MCP Sync Service
 *
 * Syncs Home Assistant data to MCP Librarian on app startup/sync.
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
/**
 * Fetch HA services (available actions)
 */
export async function fetchHAServices(url, token) {
    const response = await fetch(`${url.replace(/\/$/, '')}/api/services`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });
    if (!response.ok) {
        console.warn('Failed to fetch HA services:', response.status);
        return {};
    }
    const services = await response.json();
    // Convert array to domain-keyed object
    const result = {};
    for (const svc of services) {
        result[svc.domain] = svc.services;
    }
    return result;
}
/**
 * Sync a Batch of Services to MCP Librarian
 * @param sync_mode - "start" (first batch), "append" (middle), "complete" (last), "replace" (single shot)
 */
export async function syncBatchToLibrarian(connectionId, entityStates, services, sync_mode = 'replace') {
    try {
        console.log(`[MCP Sync] Sending batch (mode: ${sync_mode})`);
        // Send batch to Librarian
        const response = await fetch(`${SUPABASE_URL}/functions/v1/mcp-librarian/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                connection_id: connectionId,
                entities: entityStates,
                services,
                sync_mode
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[MCP Sync] Librarian error:', errorText);
            return { success: false, processed: 0, error: errorText };
        }
        const result = await response.json();
        console.log(`[MCP Sync] Batch done: ${result.devices || 0} total devices, ${result.tools || 0} total tools`);
        return {
            success: true,
            processed: result.new_tools || 0,
            devices: result.devices,
            tools: result.tools
        };
    }
    catch (error) {
        console.error('[MCP Sync] Error:', error);
        return { success: false, processed: 0, error: error.message };
    }
}
