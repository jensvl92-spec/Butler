import { HAConnection, AIAction } from './types.ts'
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

export async function getConnectionDetails(connectionId: string, supabase: any): Promise<HAConnection> {
    console.log(`[ha-api] 🔍 Fetching connection details for ID: ${connectionId}`);
    const { data, error } = await supabase.from('ha_connections').select('*').eq('id', connectionId).single();

    if (error) {
        console.error(`[ha-api] ❌ Database error finding connection ${connectionId}:`, error);
        throw new Error(`Connection lookup failed: ${error.message} (ID: ${connectionId})`);
    }

    if (!data) {
        console.error(`[ha-api] ❌ No data returned for connection ${connectionId}`);
        throw new Error(`Connection not found (No Data) for ID: ${connectionId}`);
    }

    console.log(`[ha-api] ✅ Connection found: ${data.id} (Label: ${data.label || 'N/A'})`);
    return data;
}

export async function getRecentHistory(connectionId: string, supabase: any): Promise<string> {
    try {
        const { data } = await supabase.from('chat_history')
            .select('user_message, ai_response, created_at')
            .eq('connection_id', connectionId)
            .order('created_at', { ascending: false })
            .limit(5);

        if (!data || data.length === 0) return "";
        return data.reverse().map((m: any) => {
            const resp = typeof m.ai_response === 'object' ? JSON.stringify(m.ai_response) : m.ai_response;
            return `User: ${m.user_message}\nAI: ${resp}`;
        }).join('\n---\n');
    } catch (e) {
        return "";
    }
}

export async function fetchHAConfig(connection: HAConnection) {
    try {
        const res = await fetch(`${connection.api_url}/api/config`, {
            headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" }
        });
        if (res.ok) return await res.json();
        return null;
    } catch (e) {
        console.error("Failed to fetch HA Config", e);
        return null;
    }
}

export async function fetchHAStates(connection: HAConnection) {
    try {
        const res = await fetch(`${connection.api_url}/api/states`, {
            headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" }
        });
        if (res.ok) return await res.json();
        return [];
    } catch (e) {
        console.error("Failed to fetch HA States", e);
        return [];
    }
}

export async function callHAService(connection: HAConnection, domain: string, service: string, data: any) {
    const res = await fetch(`${connection.api_url}/api/services/${domain}/${service}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Service Call Failed: ${res.status} - ${await res.text()}`);
    return await res.json();
}

export async function createHAAutomation(connection: HAConnection, payload: any, alias: string) {
    // Generate ID
    const idStr = alias.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const uniqueId = `${idStr}_${Date.now()}`;
    const p = { ...payload, id: uniqueId, alias: alias };

    const res = await fetch(`${connection.api_url}/api/config/automation/config/${uniqueId}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(p)
    });

    if (!res.ok) throw new Error(`Automation Create Failed: ${res.status} - ${await res.text()}`);
    return uniqueId;
}

export async function createHAScript(connection: HAConnection, payload: any, alias: string) {
    const idStr = alias.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const uniqueId = `${idStr}_${Date.now()}`;
    const p = { ...payload, alias: alias };

    const res = await fetch(`${connection.api_url}/api/config/script/config/${uniqueId}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(p)
    });

    if (!res.ok) throw new Error(`Script Create Failed: ${res.status} - ${await res.text()}`);
    return uniqueId;
}

export async function deleteHAAutomation(connection: HAConnection, entityIdOrId: string) {
    // 1. We need the internal ID, not just entity_id. Fetch list first.
    const listRes = await fetch(`${connection.api_url}/api/config/automation/config`, {
        headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" }
    });
    if (!listRes.ok) throw new Error("Failed to list automations");

    const automations: any[] = await listRes.json();
    const target = automations.find(a => {
        const slug = "automation." + a.alias.toLowerCase().replace(/[^a-z0-9]/g, '_');
        return slug === entityIdOrId || a.id === entityIdOrId;
    });

    if (!target) throw new Error("Automation not found");

    const delRes = await fetch(`${connection.api_url}/api/config/automation/config/${target.id}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" }
    });

    if (!delRes.ok) throw new Error(`Delete Failed: ${delRes.status}`);
    return true;
}

export async function syncScriptsToDB(connection: HAConnection, supabase: any) {
    try {
        console.log(`🔄 Syncing scripts for ${connection.id}...`);
        const states = await fetchHAStates(connection);
        const scripts = states.filter((s: any) => s.entity_id.startsWith('script.'));

        if (scripts.length === 0) return 0;

        const upsertData = scripts.map((s: any) => ({
            connection_id: connection.id,
            entity_id: s.entity_id,
            alias: s.attributes.friendly_name || s.entity_id.split('.')[1],
            description: "Imported from Home Assistant",
            last_synced_at: new Date().toISOString()
        }));

        // Upsert (requires unique constraint on connection_id + entity_id)
        const { error } = await supabase.from('automations').upsert(upsertData, { onConflict: 'connection_id,entity_id' });

        if (error) {
            console.error("Sync Upsert Validation Error", error);
            // Fallback: Delete and Insert (if conflict not working)
            // But we added the unique constraint in migration.
            throw error;
        }

        console.log(`✅ Synced ${scripts.length} scripts.`);
        return scripts.length;
    } catch (e) {
        console.error("Script Sync Failed", e);
        return 0;
    }
}
