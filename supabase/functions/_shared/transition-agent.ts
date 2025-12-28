// transition-agent.ts
// Handles "Major Moves" (Navigation Started, Zone Entry/Exit)
// Acts as a "Welcome Home" agent with Traffic Scouting & Home Prep.

import { createClient } from "npm:@supabase/supabase-js@2.38.4"
import { HAConnection, HAEvent } from './types.ts'
import { fetchHAConfig, fetchHAStates, callHAService } from './ha-api.ts'
import { chatCompletion, parseJSONResponse } from './llm-service.ts'

// @ts-ignore
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
// @ts-ignore
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
// @ts-ignore
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
    userTier: string = 'free' // Default to free, but currently logic is unrestricted
): Promise<TransitionResult> {

    console.log(`🚗 Transition Agent Activated: ${event.event_type} (${userTier})`);

    // 1. SCOUT TRAFFIC (If Navigation Started)
    let trafficContext = "";
    if (event.event_type === "navigation_started" || event.event_type === "traffic_check") {
        trafficContext = await scoutTraffic(event.attributes?.location, event.attributes?.destination);
    }

    // 2. FETCH HOME CONTEXT
    const homeContext = await getHomeSnapshot(connection);

    // 3. CHECK AUTOMATIONS (Deduplication)
    // We don't want to suggest things deemed "Already Automated"
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: existingAutomations } = await supabase
        .from('automations')
        .select('title, description')
        .eq('disabled', false); // Only check active ones

    const automationContext = existingAutomations && existingAutomations.length > 0
        ? `EXISTING AUTOMATIONS (Do NOT suggest these again):\n${existingAutomations.map((a: any) => `- ${a.title}`).join('\n')}`
        : "No existing automations found.";


    // 4. LLM DECISION
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
    
    OUTPUT JSON:
    {
        "title": "Turn on Hallway Lights",
        "description": "It's getting dark and you are 10 mins away.",
        "actions": [{ "service": "light.turn_on", "entity_id": "light.hallway" }],
        "meta_question": "Shall I do this every time you leave work?"
    }
    OR "NO_SUGGESTION"
    `;

    const userContent = `Event: ${event.event_type}. State: ${event.state}. Attributes: ${JSON.stringify(event.attributes)}`;

    const content = await chatCompletion([
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
    ], 300);

    const suggestion = parseJSONResponse(content);

    if (!suggestion || content.includes("NO_SUGGESTION")) {
        return { executed: false };
    }

    // 5. SUPPRESSION CHECK (2-Strike Rule)
    // Dynamic Query: Have we rejected this specific title >= 2 times?
    const { count, error } = await supabase
        .from('suggestions')
        .select('*', { count: 'exact', head: true })
        .eq('title', suggestion.title)
        .eq('status', 'rejected');

    if (count && count >= 2) {
        console.log(`🚫 Suppressing suggestion "${suggestion.title}" (Rejected ${count} times)`);
        return { executed: false };
    }

    // 6. EXECUTE / SUGGEST
    // For "Testing Phase", we might just push a notification asking.
    // We return the suggestion so the caller (proactive-butler) can save it and push it.

    return {
        executed: true,
        suggestion: suggestion,
        push_title: suggestion.title,
        push_body: suggestion.description + (suggestion.meta_question ? `\n(Tap to Automate)` : "")
    };
}

async function scoutTraffic(origin: string = "Current Location", dest: string = "Home"): Promise<string> {
    if (!SERPER_API_KEY) return "Traffic Scout: No API Key.";
    try {
        console.log(`🚗 Scouting Traffic: ${origin} to ${dest}`);
        const searchRes = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ q: `traffic ${origin} to ${dest} details`, num: 3 })
        });
        if (searchRes.ok) {
            const data = await searchRes.json();
            return `TRAFFIC REPORT:\n${data.organic?.map((r: any) => r.snippet).join('\n') || "No major delays reported."}`;
        }
    } catch (e) { console.error("Traffic Scout Failed", e); }
    return "Traffic Scout: Failed to Retrieve.";
}

async function getHomeSnapshot(connection: HAConnection): Promise<string> {
    try {
        const states = await fetchHAStates(connection);
        const climate = states.filter((e: any) => e.entity_id.startsWith('climate.'));
        const lights = states.filter((e: any) => e.entity_id.startsWith('light.') && e.state === 'on');
        const covers = states.filter((e: any) => e.entity_id.startsWith('cover.'));

        return `
        HOME STATE:
        - Thermostats: ${climate.map((c: any) => `${c.attributes.friendly_name}: ${c.state} (${c.attributes.current_temperature}°C)`).join(', ')}
        - Lights On: ${lights.length > 0 ? lights.map((l: any) => l.attributes.friendly_name).join(', ') : "None"}
        - Doors/Garages: ${covers.map((c: any) => `${c.attributes.friendly_name}: ${c.state}`).join(', ')}
        `;
    } catch (e) { return "Home State: Unknown (Error fetching)"; }
}
