// transition-agent.ts
// Handles "Major Moves" (Navigation Started, Zone Entry/Exit)
// Acts as a "Welcome Home" agent with Traffic Scouting & Home Prep.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HAConnection, HAEvent } from './types.ts';
import { fetchHAStates } from './ha-api.ts';
import { chatCompletion, parseJSONResponse } from './llm-service.ts';
import { fetchWithTimeout } from './model-registry.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SERPER_API_KEY = Deno.env.get("SERPER_API_KEY");

interface TransitionResult {
    executed: boolean;
    suggestion?: any;
    push_title?: string;
    push_body?: string;
}

export async function runTransitionAgent(
    event: HAEvent,
    connection: HAConnection,
    userTier: string = 'free'
): Promise<TransitionResult> {
    console.log(`🚗 Transition Agent Activated: ${event.event_type} (${userTier})`);

    // 1. SCOUT TRAFFIC (If Navigation Started)
    let trafficContext = "";
    if (event.event_type === "navigation_started" || event.event_type === "traffic_check") {
        trafficContext = await scoutTraffic(event.attributes?.location, event.attributes?.destination);
    }

    // 2. FETCH HOME CONTEXT
    const homeContext = await getHomeSnapshot(connection);

    // 3. CHECK AUTOMATIONS (Tenant-scoped Deduplication using real schema columns)
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: existingAutomations } = await supabase
        .from('automations')
        .select('alias, description')
        .eq('connection_id', connection.id);

    const automationContext = existingAutomations && existingAutomations.length > 0
        ? `EXISTING AUTOMATIONS (Do NOT suggest these again):\n${existingAutomations.map((a: any) => `- ${a.alias || a.description || 'Unnamed'}`).join('\n')}`
        : "No existing automations found.";

    // 4. LLM DECISION (Centralized fast_interactive tier)
    const systemPrompt = `
    You are a Proactive Transition Manager.
    User is moving: ${event.event_type} -> ${event.attributes?.destination || "Unknown"}.
    
    GOAL: Suggest ONE helpful "Welcome Home" or "Leave Work" action.
    
    CONTEXT:
    ${trafficContext}
    ${homeContext}
    ${automationContext}

    RULES:
    1. Check "EXISTING AUTOMATIONS" first. If the user already has a rule for this, return "NO_SUGGESTION".
    2. Focus on Comfort (Heating/Cooling) & Safety (Lights).
    3. If Traffic is bad, warn the user.
    4. Use ONLY real entity_ids shown in HOME STATE.
    
    OUTPUT JSON:
    {
        "title": "Turn on Hallway Lights",
        "description": "It's getting dark and you are 10 mins away.",
        "actions": [{ "domain": "light", "service": "turn_on", "entity_id": "light.hallway" }],
        "meta_question": "Shall I do this every time you leave work?"
    }
    OR "NO_SUGGESTION"
    `;

    const userContent = `Event: ${event.event_type}. State: ${event.state}. Attributes: ${JSON.stringify(event.attributes)}`;

    const content = await chatCompletion([
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
    ], 400, 0.3, undefined, undefined, undefined, { effort: 'low' }, 'fast_interactive');

    const suggestion = parseJSONResponse(content);

    if (!suggestion || (typeof content === 'string' && content.includes("NO_SUGGESTION"))) {
        return { executed: false };
    }

    // 5. SUPPRESSION CHECK (2-Strike Rule, scoped by connection_id!)
    const { count } = await supabase
        .from('suggestions')
        .select('*', { count: 'exact', head: true })
        .eq('connection_id', connection.id)
        .eq('title', suggestion.title)
        .eq('status', 'rejected');

    if (count && count >= 2) {
        console.log(`🚫 Suppressing suggestion "${suggestion.title}" (Rejected ${count} times)`);
        return { executed: false };
    }

    return {
        executed: true,
        suggestion,
        push_title: suggestion.title,
        push_body: suggestion.description + (suggestion.meta_question ? `\n(Tap to Automate)` : "")
    };
}

async function scoutTraffic(origin: string = "Current Location", dest: string = "Home"): Promise<string> {
    if (!SERPER_API_KEY) return "Traffic Scout: No API Key.";
    try {
        console.log(`🚗 Scouting Traffic: ${origin} to ${dest}`);
        const searchRes = await fetchWithTimeout("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ q: `traffic ${origin} to ${dest} details`, num: 3 })
        }, 10000);
        if (searchRes.ok) {
            const data = await searchRes.json();
            return `TRAFFIC REPORT:\n${data.organic?.map((r: any) => r.snippet).join('\n') || "No major delays reported."}`;
        }
    } catch (e) {
        console.error("Traffic Scout Failed", e);
    }
    return "Traffic Scout: Failed to Retrieve.";
}

async function getHomeSnapshot(connection: HAConnection): Promise<string> {
    try {
        const states = await fetchHAStates(connection);
        const climate = states.filter((e: any) => e.entity_id?.startsWith('climate.'));
        const lights = states.filter((e: any) => e.entity_id?.startsWith('light.') && e.state === 'on');
        const covers = states.filter((e: any) => e.entity_id?.startsWith('cover.'));

        return `
        HOME STATE:
        - Thermostats: ${climate.map((c: any) => `${c.attributes?.friendly_name || c.entity_id} (${c.entity_id}): ${c.state} (${c.attributes?.current_temperature}°C)`).join(', ') || "None"}
        - Lights On: ${lights.length > 0 ? lights.map((l: any) => `${l.attributes?.friendly_name || l.entity_id} (${l.entity_id})`).join(', ') : "None"}
        - Doors/Garages: ${covers.map((c: any) => `${c.attributes?.friendly_name || c.entity_id} (${c.entity_id}): ${c.state}`).join(', ') || "None"}
        `;
    } catch {
        return "Home State: Unknown (Error fetching)";
    }
}
