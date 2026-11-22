/**
 * MCP Sync Service
 *
 * Syncs Home Assistant data to MCP Librarian using the authenticated user's Supabase JWT.
 */

import { supabase } from '../lib/supabase';
import { buildHAUrl, sanitizeHAToken, fetchWithTimeout } from './home-assistant';

const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL || '';

/**
 * Fetch HA services (available actions)
 */
export async function fetchHAServices(url: string, token: string): Promise<Record<string, any>> {
    try {
        const response = await fetchWithTimeout(buildHAUrl('/api/services', url), {
            headers: {
                'Authorization': `Bearer ${sanitizeHAToken(token)}`,
                'Content-Type': 'application/json'
            }
        }, 15000);

        if (!response.ok) {
            console.warn('Failed to fetch HA services:', response.status);
            return {};
        }

        const services = await response.json();
        if (!Array.isArray(services)) return {};

        const result: Record<string, any> = {};
        for (const svc of services) {
            if (svc?.domain && svc?.services) {
                result[svc.domain] = svc.services;
            }
        }

        return result;
    } catch (e) {
        console.warn('Error fetching HA services:', e);
        return {};
    }
}

/**
 * Sync a Batch of Services to MCP Librarian using the user's real session JWT.
 */
export async function syncBatchToLibrarian(
    connectionId: string,
    entityStates: any[],
    services: Record<string, any>,
    sync_mode: 'start' | 'append' | 'complete' | 'replace' = 'replace'
): Promise<{ success: boolean; processed: number; devices?: number; tools?: number; error?: string }> {
    try {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData?.session?.access_token;

        if (!accessToken) {
            return { success: false, processed: 0, error: 'Niet ingelogd (geen sessietoken).' };
        }

        if (!SUPABASE_URL) {
            const { data, error } = await supabase.functions.invoke('mcp-librarian/sync', {
                body: {
                    connection_id: connectionId,
                    entities: entityStates,
                    services,
                    sync_mode
                }
            });
            if (error) return { success: false, processed: 0, error: error.message };
            return {
                success: true,
                processed: data?.new_tools || 0,
                devices: data?.devices,
                tools: data?.tools
            };
        }

        const response = await fetchWithTimeout(`${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/mcp-librarian/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({
                connection_id: connectionId,
                entities: entityStates,
                services,
                sync_mode
            })
        }, 30000);

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            console.error('[MCP Sync] Librarian error:', errorText);
            return { success: false, processed: 0, error: errorText || `HTTP ${response.status}` };
        }

        const result = await response.json();
        return {
            success: true,
            processed: result.new_tools || 0,
            devices: result.devices,
            tools: result.tools
        };
    } catch (error: any) {
        console.error('[MCP Sync] Error:', error);
        return { success: false, processed: 0, error: error?.message || String(error) };
    }
}
