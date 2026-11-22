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

function getSeason(date: Date): string {
    const month = date.getMonth();
    if (month >= 2 && month <= 4) return 'lente';
    if (month >= 5 && month <= 7) return 'zomer';
    if (month >= 8 && month <= 10) return 'herfst';
    return 'winter';
}

function getLocalHour(date: Date, timezone: string): number {
    try {
        const hourStr = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone,
            hour: '2-digit',
            hour12: false
        }).format(date);
        const h = parseInt(hourStr, 10);
        return Number.isFinite(h) ? h % 24 : date.getUTCHours();
    } catch {
        return date.getUTCHours();
    }
}

function getTimeOfDay(hours: number): 'ochtend' | 'middag' | 'avond' | 'nacht' {
    if (hours >= 6 && hours < 12) return 'ochtend';
    if (hours >= 12 && hours < 18) return 'middag';
    if (hours >= 18 && hours < 23) return 'avond';
    return 'nacht';
}

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

    // 4. Load Explicit Core Memory Blocks (Tenant-scoped by connection_id)
    let coreMemories: Array<{ id: string; type: string; content: string }> = [];
    try {
        let query = supabase
            .from('memories')
            .select('id, type, content, metadata')
            .order('created_at', { ascending: false })
            .limit(15);

        if (connectionId) {
            query = query.eq('connection_id', connectionId);
        }

        const { data, error } = await query;

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

    const localHour = getLocalHour(now, timezone);

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
            timeOfDay: getTimeOfDay(localHour),
            presenceSummary,
            activeDevicesCount: activeControllable
        },
        coreMemories
    };
}

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

export async function saveCoreMemory(
    supabase: any,
    content: string,
    type: 'preference' | 'household' | 'routine' | 'rule' = 'preference',
    metadata: Record<string, any> = {},
    connectionId?: string
): Promise<{ success: boolean; id?: string }> {
    if (!content || !content.trim()) return { success: false };
    try {
        let embedding: number[] | null = null;
        try {
            embedding = await createEmbedding(content);
        } catch {
            // optional
        }

        const payload: any = {
            content: content.trim(),
            type,
            metadata
        };
        if (connectionId) payload.connection_id = connectionId;
        if (embedding) payload.embedding = embedding;

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

export async function deleteCoreMemory(
    supabase: any,
    memoryIdOrText: string,
    connectionId?: string
): Promise<boolean> {
    const trimmed = (memoryIdOrText || '').trim();
    if (!trimmed) return false;

    try {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
        if (isUUID) {
            let query = supabase.from('memories').delete().eq('id', trimmed);
            if (connectionId) query = query.eq('connection_id', connectionId);
            const { error } = await query;
            return !error;
        }

        // Guard against wildcard or overly short deletes that would wipe all memories
        const sanitized = trimmed.replace(/[%_*]/g, '').trim();
        if (sanitized.length < 3) {
            console.warn('[Memory] Refusing overly broad memory delete pattern');
            return false;
        }

        let query = supabase.from('memories').delete().ilike('content', `%${sanitized}%`);
        if (connectionId) query = query.eq('connection_id', connectionId);
        const { error } = await query;
        return !error;
    } catch (e) {
        console.error('[Memory] Delete exception:', e);
        return false;
    }
}

export async function retrieveMemories(query: string, supabase: any, connectionId?: string): Promise<string> {
    try {
        const embedding = await createEmbedding(query);
        if (!embedding) return '';
        const { data: memories } = await supabase.rpc('match_memories', {
            query_embedding: embedding,
            match_threshold: 0.6,
            match_count: 5
        });
        if (memories && memories.length > 0) {
            const scoped = connectionId
                ? memories.filter((m: any) => !m.connection_id || m.connection_id === connectionId)
                : memories;
            return scoped.map((m: any) => `- ${m.content}`).join('\n');
        }
    } catch {
        /* ignore */
    }
    return '';
}

export async function saveChatHistory(req: any, res: any, actions: any[], supabase: any) {
    try {
        const payload = {
            connection_id: req.connection_id,
            user_message: req.user_message,
            ai_response: typeof res?.text === 'string' ? res.text : JSON.stringify(res || ''),
            actions_taken: actions || [],
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
