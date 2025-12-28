// consultant-agent.ts
// The "On-Demand" interface to the Automation Expert.
// Triggered when user asks: "What should I automate?", "Any suggestions?"

import { PatternEngine, PatternResult } from './pattern-engine.ts'
import { chatCompletion, parseJSONResponse } from './llm-service.ts'
import { AIResponse, HAConnection } from './types.ts'

/**
 * AUTOMATION CONSULTANT AGENT
 */
export async function runConsultantAgent(
    user_message: string,
    connection: HAConnection,
    context: string
): Promise<AIResponse> {

    console.log("🔮 ACTIVATING AUTOMATION CONSULTANT 🔮");
    const engine = new PatternEngine();

    // 1. Define Tools
    const tools = [
        {
            type: "function",
            function: {
                name: "scan_my_history",
                description: "Scans the user's Home Assistant history to find repetitive patterns that can be automated.",
                parameters: {
                    type: "object",
                    properties: {
                        days_to_scan: { type: "number", description: "Number of days to analyze (default 3-7)" }
                    }
                }
            }
        }
    ];

    // 2. System Prompt
    const consultantPrompt = `
    IDENTITY:
    You are the "Automation Consultant".
    You help the user find ways to make their smart home smarter.
    
    GOAL:
    Answer the user's request for automation advice.
    
    SUPERPOWER:
    You can use the tool \`scan_my_history\` to find actual habits.
    
    INSTRUCTIONS:
    1. If the user asks for suggestions/help, CALL \`scan_my_history\`.
    2. Review the patterns returned by the tool.
    3. Present the best ones to the user clearly.
    4. Ask if they want to apply any of them (The user will have to say "Yes" in the next turn, you cannot check the box for them yet).
    
    OUTPUT FORMAT:
    Standard AIResponse JSON.
    {
      "text": "I found a pattern: You always turn off the heater at 9AM. Shall I automate this?",
      "actions": [] 
    }
    `;

    const messages: any[] = [
        { role: "system", content: consultantPrompt },
        { role: "user", content: `CONTEXT:\n${context}\n\nUSER REQUEST:\n${user_message}` }
    ];

    // 3. Execution Loop
    for (let turn = 0; turn < 3; turn++) {
        const response: any = await chatCompletion(messages, 600, 0, tools);
        // a) Final Response
        if (response.content && !response.tool_calls) {
            const finalRes = parseJSONResponse(response.content) || { text: response.content, actions: [], language: "en" };
            // Attach Debug Info if available
            if ((messages as any).debug_metadata) {
                finalRes.tool_debug_info = (messages as any).debug_metadata;
            }
            return finalRes;
        }

        // b) Tool Call
        if (response.tool_calls) {
            const toolCall = response.tool_calls[0];
            const funcName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments || "{}");

            console.log(`🛠️ Consultant Tool Call: ${funcName}`, args);

            let resultString = "No patterns found.";
            if (funcName === 'scan_my_history') {
                try {
                    console.log("🚀 Running Analysis Inline...");
                    const { patterns, eventCount, debugUrl } = await engine.scanConnection(connection, args.days_to_scan || 3);

                    const debugInfo = {
                        msg: `Analyzed ${eventCount} events.`,
                        url: debugUrl,
                        using_dns: debugUrl.includes("duckdns") ? "YES" : "NO"
                    };

                    resultString = JSON.stringify({
                        status: "success",
                        count: patterns.length,
                        patterns: patterns,
                        debug_metadata: debugInfo
                    });

                    // Store for return
                    (messages as any).debug_metadata = debugInfo;

                } catch (err: any) {
                    console.error("❌ Consultant Tool Error:", err);
                    resultString = `ERROR: Could not analyze. details: ${err.message}`;
                }
            }

            messages.push(response);
            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                name: funcName,
                content: resultString
            });
        }
    }

    return { text: "I tried to analyze your home but ran out of time.", actions: [], language: "en" };
}
