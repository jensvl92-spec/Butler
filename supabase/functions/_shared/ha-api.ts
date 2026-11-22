import { HAConnection } from './types.ts';
import { isSafeExternalUrl } from './auth.ts';
import { fetchWithTimeout } from './model-registry.ts';

function normalizeApiUrl(rawUrl: string): string {
    const trimmed = (rawUrl || '').trim().replace(/\/+$/, '');
    if (!isSafeExternalUrl(trimmed)) {
        throw new Error(`Unsafe or invalid Home Assistant URL`);
    }
    return trimmed;
}

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
    } catch {
        return "";
    }
}

export async function fetchHAConfig(connection: HAConnection) {
    try {
        const base = normalizeApiUrl(connection.api_url);
        const res = await fetchWithTimeout(`${base}/api/config`, {
            headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" }
        }, 12000);
        if (res.ok) return await res.json();
        return null;
    } catch (e) {
        console.error("Failed to fetch HA Config", e);
        return null;
    }
}

export async function fetchHAStates(connection: HAConnection) {
    try {
        const base = normalizeApiUrl(connection.api_url);
        const res = await fetchWithTimeout(`${base}/api/states`, {
            headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" }
        }, 15000);
        if (res.ok) return await res.json();
        return [];
    } catch (e) {
        console.error("Failed to fetch HA States", e);
        return [];
    }
}

export async function callHAService(connection: HAConnection, domain: string, service: string, data: any) {
    const base = normalizeApiUrl(connection.api_url);
    if (!/^[a-z0-9_]+$/i.test(domain) || !/^[a-z0-9_]+$/i.test(service)) {
        throw new Error(`Invalid HA domain or service: ${domain}.${service}`);
    }
    const res = await fetchWithTimeout(`${base}/api/services/${domain}/${service}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(data || {})
    }, 15000);
    if (!res.ok) throw new Error(`Service Call Failed: ${res.status} - ${await res.text()}`);
    const text = await res.text();
    if (!text) return [];
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

export async function createHAAutomation(connection: HAConnection, payload: any, alias: string) {
    const base = normalizeApiUrl(connection.api_url);
    const idStr = (alias || 'butler_automation').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const uniqueId = `${idStr}_${Date.now()}`;
    const { ready_for_user_review: _r, message: _m, ...cleanPayload } = payload || {};
    const p = { ...cleanPayload, id: uniqueId, alias: alias || 'Butler Automation' };

    const res = await fetchWithTimeout(`${base}/api/config/automation/config/${uniqueId}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(p)
    }, 15000);

    if (!res.ok) throw new Error(`Automation Create Failed: ${res.status} - ${await res.text()}`);
    return uniqueId;
}

export async function createHAScript(connection: HAConnection, payload: any, alias: string) {
    const base = normalizeApiUrl(connection.api_url);
    const idStr = (alias || 'butler_script').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const uniqueId = `${idStr}_${Date.now()}`;
    const p = { ...payload, alias: alias || 'Butler Script' };

    const res = await fetchWithTimeout(`${base}/api/config/script/config/${uniqueId}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(p)
    }, 15000);

    if (!res.ok) throw new Error(`Script Create Failed: ${res.status} - ${await res.text()}`);
    return uniqueId;
}

export async function deleteHAAutomation(connection: HAConnection, entityIdOrId: string) {
    const base = normalizeApiUrl(connection.api_url);
    let targetId = entityIdOrId;

    if (entityIdOrId.startsWith('automation.')) {
        // Resolve internal config ID via entity state attributes.id (HA standard)
        const stateRes = await fetchWithTimeout(`${base}/api/states/${encodeURIComponent(entityIdOrId)}`, {
            headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" }
        }, 12000);
        if (stateRes.ok) {
            const st = await stateRes.json();
            if (st?.attributes?.id) {
                targetId = String(st.attributes.id);
            }
        }
    }

    const delRes = await fetchWithTimeout(`${base}/api/config/automation/config/${encodeURIComponent(targetId)}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${connection.api_token}`, "Content-Type": "application/json" }
    }, 12000);

    if (!delRes.ok) throw new Error(`Delete Failed: ${delRes.status} - ${await delRes.text()}`);
    return true;
}

export async function syncScriptsToDB(connection: HAConnection, supabase: any) {
    try {
        console.log(`🔄 Syncing scripts for ${connection.id}...`);
        const states = await fetchHAStates(connection);
        const scripts = states.filter((s: any) => s.entity_id?.startsWith('script.'));

        if (scripts.length === 0) return 0;

        const upsertData = scripts.map((s: any) => ({
            connection_id: connection.id,
            entity_id: s.entity_id,
            alias: s.attributes?.friendly_name || s.entity_id.split('.')[1],
            description: "Imported from Home Assistant",
            last_synced_at: new Date().toISOString()
        }));

        const { error } = await supabase.from('automations').upsert(upsertData, { onConflict: 'connection_id,entity_id' });
        if (error) throw error;

        console.log(`✅ Synced ${scripts.length} scripts.`);
        return scripts.length;
    } catch (e) {
        console.error("Script Sync Failed", e);
        return 0;
    }
}
