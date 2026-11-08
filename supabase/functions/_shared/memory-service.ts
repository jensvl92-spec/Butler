import { createEmbedding } from './llm-service.ts';

export interface UserLocation {
    lat: number;
    lon: number;
    name?: string;
}

export interface DynamicWorkingContext {
    userPersona: {
        name: string;
        language: string;
        location: UserLocation | null;
        timezone: string;
    };
    homeState: {
        currentTime: string;
        season: string;
        timeOfDay: 'ochtend' | 'middag' | 'avond' | 'nacht';
        presenceSummary: string;
        activeDevicesCount: number;
    };
    coreMemories: Array<{
        id: string;
        type: string;
        content: string;
    }>;
}

/**
 * Determine season from date and latitude (defaulting to Northern Hemisphere)
 */
function getSeason(date: Date): string {
    const month = date.getMonth(); // 0-11
    if (month >= 2 && month <= 4) return 'lente';
    if (month >= 5 && month <= 7) return 'zomer';
    if (month >= 8 && month <= 10) return 'herfst';
    return 'winter';
}

/**
 * Determine time of day in Dutch
 */
function getTimeOfDay(hours: number): 'ochtend' | 'middag' | 'avond' | 'nacht' {
    if (hours >= 6 && hours < 12) return 'ochtend';
    if (hours >= 12 && hours < 18) return 'middag';
    if (hours >= 18 && hours < 23) return 'avond';
    return 'nacht';
}

/**
 * Build State-of-the-Art Dynamic Working Context (Tier 1 + Tier 2)
 * Live from Home Assistant topology, client payload, and persistent memory table.
 * NO HARDCODED STRINGS (no fake "Amsterdam" persona).
 */
export async function buildDynamicWorkingContext(
    supabase: any,
    connectionId: string,
    payload: {
        language?: string;
        location?: UserLocation | null;
        devices?: any[];
        client_timestamp?: string;
        client_timezone?: string;
    }
): Promise<DynamicWorkingContext> {
    const timezone = payload.client_timezone || 'Europe/Brussels';
    const now = payload.client_timestamp ? new Date(payload.client_timestamp) : new Date();

    // 1. Resolve Dynamic Location (GPS priority, fallback to HA zone.home)
    let location: UserLocation | null = payload.location || null;
    const devices = payload.devices || [];

    if (!location && devices.length > 0) {
        const homeZone = devices.find((d: any) => d.entity_id === 'zone.home');
        if (homeZone?.attributes?.latitude && homeZone?.attributes?.longitude) {
            location = {
                lat: Number(homeZone.attributes.latitude),
                lon: Number(homeZone.attributes.longitude),
                name: homeZone.attributes.friendly_name || 'Thuis'
            };
        }
    }

    // 2. Resolve Presence (person.* entities)
    const personEntities = devices.filter((d: any) => d.entity_id?.startsWith('person.'));
    let presenceSummary = 'Niemand specifiek gedetecteerd';
    if (personEntities.length > 0) {
        const homePersons = personEntities.filter((p: any) => p.state === 'home');
        if (homePersons.length > 0) {
            presenceSummary = `${homePersons.map((p: any) => p.attributes?.friendly_name || p.entity_id.replace('person.', '')).join(', ')} (thuis)`;
        } else {
            presenceSummary = 'Iedereen is weg (niemand thuis)';
        }
    }

    // 3. Count Active Controllable Devices
    const activeControllable = devices.filter((d: any) => {
        const domain = d.entity_id?.split('.')[0];
        return ['light', 'switch', 'climate', 'media_player', 'cover'].includes(domain) && d.state && d.state !== 'unavailable' && d.state !== 'off';
    }).length;

    // 4. Load Explicit Core Memory Blocks (Tier 2) from database
    let coreMemories: Array<{ id: string; type: string; content: string }> = [];
    try {
        const { data, error } = await supabase
            .from('memories')
            .select('id, type, content, metadata')
            .order('created_at', { ascending: false })
            .limit(15);

        if (!error && data) {
            coreMemories = data.map((row: any) => ({
                id: row.id,
                type: row.type || 'preference',
                content: row.content
            }));
        }
    } catch (e) {
        console.warn('[Memory] Failed to load explicit core memories:', e);
    }

    return {
        userPersona: {
            name: 'Eigenaar',
            language: payload.language || 'nl-BE',
            location,
            timezone
        },
        homeState: {
            currentTime: now.toLocaleString('nl-NL', { timeZone: timezone }),
            season: getSeason(now),
            timeOfDay: getTimeOfDay(now.getHours()),
            presenceSummary,
            activeDevicesCount: activeControllable
        },
        coreMemories
    };
}

/**
 * Render Working Context into authoritative system prompt block
 */
export function formatWorkingMemoryPrompt(context: DynamicWorkingContext): string {
    const locStr = context.userPersona.location
        ? `${context.userPersona.location.lat.toFixed(4)}, ${context.userPersona.location.lon.toFixed(4)}${context.userPersona.location.name ? ` (${context.userPersona.location.name})` : ''}`
        : 'Onbekend (vraag indien strikt nodig)';

    const memoryBlocks = context.coreMemories.length > 0
        ? context.coreMemories.map(m => `- [${m.type.toUpperCase()}] ${m.content} (id: ${m.id})`).join('\n')
        : 'Geen specifieke voorkeuren opgeslagen.';

    return `
[CORE WORKING MEMORY (SOTA DYNAMIC CONTEXT)]
- Tijd & Datum: ${context.homeState.currentTime} (${context.homeState.timeOfDay}, ${context.homeState.season})
- Locatie: ${locStr}
- Aanwezigheid: ${context.homeState.presenceSummary}
- Actieve apparaten: ${context.homeState.activeDevicesCount}
- Taal: ${context.userPersona.language}

[PERMANENTE GEHEUGEN BLOKKEN]:
${memoryBlocks}
`.trim();
}

/**
 * Save an explicit Core Memory fact (Preference, Household fact, Routine rule)
 */
export async function saveCoreMemory(
    supabase: any,
    content: string,
    type: 'preference' | 'household' | 'routine' | 'rule' = 'preference',
    metadata: Record<string, any> = {}
): Promise<{ success: boolean; id?: string }> {
    try {
        let embedding: number[] | null = null;
        try {
            embedding = await createEmbedding(content);
        } catch {
            // embedding is optional if offline/fails
        }

        const payload: any = {
            content,
            type,
            metadata
        };
        if (embedding) {
            payload.embedding = embedding;
        }

        const { data, error } = await supabase
            .from('memories')
            .insert(payload)
            .select('id')
            .single();

        if (error) {
            console.error('[Memory] Save failed:', error);
            return { success: false };
        }
        return { success: true, id: data?.id };
    } catch (e) {
        console.error('[Memory] Save exception:', e);
        return { success: false };
    }
}

/**
 * Delete a Core Memory fact by ID or text match
 */
export async function deleteCoreMemory(supabase: any, memoryIdOrText: string): Promise<boolean> {
    try {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memoryIdOrText);
        if (isUUID) {
            const { error } = await supabase.from('memories').delete().eq('id', memoryIdOrText);
            return !error;
        }
        // Delete by content match
        const { error } = await supabase.from('memories').delete().ilike('content', `%${memoryIdOrText}%`);
        return !error;
    } catch (e) {
        console.error('[Memory] Delete exception:', e);
        return false;
    }
}

/**
 * Semantic Vector Search (Tier 4 Archival Memory)
 */
export async function retrieveMemories(query: string, supabase: any): Promise<string> {
    try {
        const embedding = await createEmbedding(query);
        if (!embedding) return '';
        const { data: memories } = await supabase.rpc('match_memories', {
            query_embedding: embedding,
            match_threshold: 0.6,
            match_count: 5
        });
        if (memories && memories.length > 0) {
            return memories.map((m: any) => `- ${m.content}`).join('\n');
        }
    } catch {
        /* ignore */
    }
    return '';
}

/**
 * Save chat history with resilient schema mapping
 */
export async function saveChatHistory(req: any, res: any, actions: any[], supabase: any) {
    try {
        const safeRes = {
            text: res.text || '',
            actions: res.actions || [],
            scheduled_actions: res.scheduled_actions || [],
            language: res.language || req.language
        };

        const payload = {
            connection_id: req.connection_id,
            user_message: req.user_message,
            ai_response: JSON.stringify(safeRes),
            actions_taken: actions,
            language: req.language || 'nl-BE'
        };

        const { error } = await supabase.from('chat_history').insert(payload);
        if (error) {
            console.error('❌ DB Insert Failed:', error);
            return { success: false, error };
        }
        return { success: true };
    } catch (e: any) {
        console.error('❌ Failed to save chat history:', e);
        return { success: false, error: e.message || e };
    }
}
