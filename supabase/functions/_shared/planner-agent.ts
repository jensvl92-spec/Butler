import { createClient } from "npm:@supabase/supabase-js@2.38.4"
import { chatCompletion, parseJSONResponse } from './llm-service.ts'
import { AIResponse, HAConnection } from './types.ts'

/**
 * HISTORY QUERY TOOL
 * Allows the Planner to look up past durations/performance.
 */
async function queryDeviceHistory(supabase: any, entity_id: string, target_state: string): Promise<string> {
    try {
        console.log(`🔎 Planner Tool: Analyzing history for ${entity_id} -> ${target_state}`);

        // 1. Get recent state changes for this entity
        const { data: logs, error } = await supabase
            .from('device_history')
            .select('state, created_at')
            .eq('entity_id', entity_id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error || !logs || logs.length < 2) return "Insufficient history data.";

        // 2. Simple Duration Analysis (Naive Implementation)
        // Find pairs of (Start State -> Target State) and measure gaps.
        // For heating: Look for 'heating' or 'on' and see how long it stayed there?
        // Actually, better to just look for ANY usage and report average "On" duration as a proxy.
        // Or if 'climate', look for Temperature change rate?

        // Fallback: Just return the last 3 timestamps it was in that state.
        const matches = logs.filter((l: any) => l.state === target_state);
        return `Found ${matches.length} recent occurrences of state '${target_state}'. Last active at: ${matches.map((m: any) => m.created_at).join(', ')}. Average duration calculation is pending more granular data.`;

    } catch (e) {
        return "Error querying history.";
    }
}

/**
 * MORNING PLANNER AGENT
 * Runs a specialized, heavy-duty prompt to analyze daily plans.
 */
export async function runMorningPlanner(
    user_message: string,
    supabase: any,
    connection: HAConnection,
    context: string
): Promise<AIResponse> {

    console.log("🌞 ACTIVATING MORNING PLANNER AGENT 🧠");

    // 1. Define Tools
    const tools = [
        {
            type: "function",
            function: {
                name: "query_device_history",
                description: "Check historical performance or duration of a device to calculate lead times. Use this when you need to know 'how long' something takes.",
                parameters: {
                    type: "object",
                    properties: {
                        entity_id: { type: "string", description: "The Entity ID (e.g. climate.bathroom)" },
                        target_state: { type: "string", description: "The state you want to achieve (e.g. heating, on, 22)" }
                    },
                    required: ["entity_id", "target_state"]
                }
            }
        }
    ];

    // 2. Specialized System Prompt
    const plannerPrompt = `
    IDENTITY:
    You are the "Logistics Expert" for a smart home.
    You are running in "Morning Planner Mode".
    
    GOAL:
    Analyze the user's plan for the day and proactively schedule Home Automation tasks.
    
    CRITICAL SUPERPOWER:
    You have access to "Forensic Tools" to check history.
    - PROACTIVELY USE THE TOOL \`query_device_history\` whenever you need to understand device behavior.
    - usage examples: checking heating duration, vacuuming time, or typical usage patterns.
    - Do NOT guess. Check data.
    
    INSTRUCTIONS:
    1. Identify user goals embedded in their reply.
    2. Map to available devices in the context.
    3. Use the TOOL to verify lead times, durations, or success rates if relevant.
    4. Return a SCHEDULED ACTION based on your findings.

    OUTPUT FORMAT (Final):
    Return strict JSON as per standard AIResponse.
    {
      "text": "I've scheduled the bathroom heater for 18:15 so it's ready for your 7pm bath.",
      "scheduled_actions": [ ... ]
    }
    `;

    const messages: any[] = [
        { role: "system", content: plannerPrompt },
        { role: "user", content: `CONTEXT:\n${context}\n\nUSER REPLY:\n${user_message}` }
    ];

    // 3. Execution Loop (Handle Tool Calls)
    // We allow up to 3 turns to prevent loops
    for (let turn = 0; turn < 3; turn++) {
        const response: any = await chatCompletion(messages, 500, 0, tools);

        // a) If it's a final content response
        if (response.content && !response.tool_calls) {
            return parseJSONResponse(response.content) || { text: response.content, actions: [], language: "en" };
        }

        // b) If it wants to use a tool
        if (response.tool_calls) {
            const toolCall = response.tool_calls[0];
            const funcName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);

            console.log(`🛠️ Planner Tool Call: ${funcName}`, args);

            let result = "Error";
            if (funcName === 'query_device_history') {
                result = await queryDeviceHistory(supabase, args.entity_id, args.target_state);
            }

            // Append messages for the next turn
            messages.push(response); // The assistant's tool_call request
            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                name: funcName,
                content: result
            });
        }
    }

    // Fallback if loop exhausted
    return { text: "I tried to plan your day but ran out of thinking steps. I've noted your plans.", actions: [], language: "en" };
}
