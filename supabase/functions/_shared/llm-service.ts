// @ts-ignore
const LLM_API_KEY = Deno.env.get("LLM_API_KEY")!
// @ts-ignore - Butler uses Gemini 3 Flash (fast, multilingual, great for agents)
const LLM_MODEL = Deno.env.get("LLM_MODEL") || "google/gemini-3-flash-preview"
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

export async function createEmbedding(text: string): Promise<number[] | null> {
    try {
        const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
            method: "POST",
            headers: { "Authorization": `Bearer ${LLM_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "text-embedding-3-small", input: text })
        });
        if (response.ok) {
            const data = await response.json();
            return data.data?.[0]?.embedding || null;
        }
        return null;
    } catch (e) {
        console.error("Embedding Error", e);
        return null;
    }
}

export async function chatCompletion(
    messages: any[],
    max_tokens: number = 500,
    temperature: number = 0.5,
    tools?: any[],
    tool_choice?: any,
    model: string = LLM_MODEL
): Promise<any> {
    const body: any = {
        model: model,
        messages: messages,
        temperature: temperature,
        max_tokens: max_tokens,
    };

    if (tools) {
        body.tools = tools;
        if (tool_choice) body.tool_choice = tool_choice;
    }

    const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${LLM_API_KEY}`,
            "HTTP-Referer": "https://aiha.app",
            "X-Title": "AI Home Assistant"
        },
        body: JSON.stringify(body),
    })

    if (!response.ok) throw new Error(`LLM API error: ${response.status} - ${await response.text()}`)
    const data = await response.json()

    // Debug: Log finish reason and usage
    const choice = data.choices?.[0];
    if (choice) {
        console.log(`[LLM] finish_reason: ${choice.finish_reason}, usage: ${JSON.stringify(data.usage || {})}`);
    }

    // If tools are used, return the full message object (content + tool_calls)
    // If simple chat, return just content string (Backwards Compatibility)
    if (tools) return data.choices[0].message;
    return data.choices[0].message.content
}

export function parseJSONResponse(content: string) {
    if (!content || content.trim() === "") return null;

    try {
        // 1. Remove markdown code blocks if present
        let cleanContent = content.replace(/```json\s*|```\s*/g, "").trim();

        // 2. Find the first occurrence of '{' or '['
        const firstBrace = cleanContent.indexOf('{');
        const firstBracket = cleanContent.indexOf('[');
        let start = -1;
        let endSymbol = '';

        if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
            start = firstBrace;
            endSymbol = '}';
        } else if (firstBracket !== -1) {
            start = firstBracket;
            endSymbol = ']';
        }

        if (start === -1) {
            console.error("[LLM] No JSON start symbol found");
            return null;
        }

        // 3. Find the last occurrence of the matching end symbol
        const lastSymbol = cleanContent.lastIndexOf(endSymbol);
        if (lastSymbol === -1 || lastSymbol < start) {
            console.error(`[LLM] No matching ${endSymbol} found after start`);
            // Attempt to parse anyway if it looks like it might just be the end of the string
            try {
                return JSON.parse(cleanContent.substring(start));
            } catch (e) {
                return null;
            }
        }

        const jsonString = cleanContent.substring(start, lastSymbol + 1);
        return JSON.parse(jsonString);
    } catch (e) {
        console.error("JSON Parse Failed. Content Start:", content.substring(0, 500));
        return null;
    }
}

/**
 * Fast router completion using Gemini Flash
 * Used for selecting relevant tools/devices from full MCP catalog
 */
export async function routerCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
    const ROUTER_MODEL = "google/gemini-3-flash-preview";

    const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${LLM_API_KEY}`,
            "HTTP-Referer": "https://aiha.app",
            "X-Title": "AI Home Assistant Router"
        },
        body: JSON.stringify({
            model: ROUTER_MODEL,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0,
            max_tokens: 2500
        }),
    });

    if (!response.ok) {
        console.error(`Router LLM error: ${response.status}`);
        return "{}";
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

// =====================================================
// GROQ API - Ultra-fast inference (8x faster than Gemini)
// =====================================================

// @ts-ignore
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// Model options (as of Jan 2025):
// - llama-3.1-8b-instant: Fastest (~750 t/s), good for simple tasks
// - llama-3.3-70b-versatile: Recommended for all 70B tasks (3.1 deprecated)
const GROQ_MODEL_FAST = "llama-3.1-8b-instant";
const GROQ_MODEL_MAIN = "llama-3.3-70b-versatile";  // Also used for tool calling

/**
 * Chat completion via Groq API (8x faster than OpenRouter/Gemini)
 * Falls back to OpenRouter if GROQ_API_KEY is not set
 */
export async function groqCompletion(
    messages: any[],
    max_tokens: number = 1000,
    temperature: number = 0.3,
    model: string = GROQ_MODEL_MAIN
): Promise<string> {
    // Fallback to OpenRouter if Groq not configured
    if (!GROQ_API_KEY) {
        console.warn("[LLM] GROQ_API_KEY not set, falling back to OpenRouter");
        return chatCompletion(messages, max_tokens, temperature) as Promise<string>;
    }

    const startTime = Date.now();

    const response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model,
            messages,
            max_tokens,
            temperature
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Groq] API error: ${response.status} - ${errorText}`);
        // Fallback to OpenRouter on error
        console.warn("[Groq] Falling back to OpenRouter");
        return chatCompletion(messages, max_tokens, temperature) as Promise<string>;
    }

    const data = await response.json();
    const elapsed = Date.now() - startTime;
    console.log(`[Groq] Response in ${elapsed}ms (model: ${model})`);

    return data.choices[0].message.content;
}

/**
 * Fast Groq completion for simple tasks (Bouncer, Router)
 * Uses smaller 8B model for maximum speed
 */
export async function groqFastCompletion(
    messages: any[],
    max_tokens: number = 200
): Promise<string> {
    return groqCompletion(messages, max_tokens, 0, GROQ_MODEL_FAST);
}

/**
 * Main Groq completion for complex tasks (Butler, Personal Assistant)
 * Uses larger 70B model for best quality
 */
export async function groqMainCompletion(
    messages: any[],
    max_tokens: number = 1500,
    temperature: number = 0.3
): Promise<string> {
    return groqCompletion(messages, max_tokens, temperature, GROQ_MODEL_MAIN);
}

/**
 * Groq completion with tool calling support (for Butler agent)
 * Returns the full message object including tool_calls
 * Falls back to OpenRouter if GROQ_API_KEY is not set
 */
export async function groqCompletionWithTools(
    messages: any[],
    max_tokens: number = 1000,
    temperature: number = 0.3,
    tools?: any[],
    tool_choice?: any
): Promise<any> {
    // Fallback to OpenRouter if Groq not configured
    if (!GROQ_API_KEY) {
        console.warn("[LLM] GROQ_API_KEY not set, falling back to OpenRouter for tool calling");
        return chatCompletion(messages, max_tokens, temperature, tools, tool_choice);
    }

    const startTime = Date.now();

    // Clean messages to remove unsupported properties (like 'refusal' from OpenAI)
    const cleanedMessages = messages.map(msg => {
        const clean: any = { role: msg.role };
        if (msg.content !== undefined) clean.content = msg.content;
        if (msg.tool_calls) clean.tool_calls = msg.tool_calls;
        if (msg.tool_call_id) clean.tool_call_id = msg.tool_call_id;
        if (msg.name) clean.name = msg.name;
        // Explicitly skip: refusal, function_call, and other OpenAI-specific fields
        return clean;
    });

    const body: any = {
        model: GROQ_MODEL_MAIN,  // llama-3.3-70b-versatile
        messages: cleanedMessages,
        max_tokens,
        temperature
    };

    if (tools) {
        body.tools = tools;
        if (tool_choice) body.tool_choice = tool_choice;
    }

    const response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Groq] Tool calling API error: ${response.status} - ${errorText}`);
        // Fallback to OpenRouter on error
        console.warn("[Groq] Falling back to OpenRouter for tool calling");
        return chatCompletion(messages, max_tokens, temperature, tools, tool_choice);
    }

    const data = await response.json();
    const elapsed = Date.now() - startTime;
    console.log(`[Groq] Tool response in ${elapsed}ms`);

    // Return full message object (with tool_calls if present)
    return data.choices[0].message;
}
