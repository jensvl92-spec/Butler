// @ts-ignore
const LLM_API_KEY = Deno.env.get("LLM_API_KEY")!
// @ts-ignore
const LLM_MODEL = Deno.env.get("LLM_MODEL") || "openai/gpt-4o-mini"
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

export async function chatCompletion(messages: any[], max_tokens: number = 500, temperature: number = 0.5, tools?: any[], tool_choice?: any): Promise<any> {
    const body: any = {
        model: LLM_MODEL,
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

    // If tools are used, return the full message object (content + tool_calls)
    // If simple chat, return just content string (Backwards Compatibility)
    if (tools) return data.choices[0].message;
    return data.choices[0].message.content
}

export function parseJSONResponse(content: string) {
    try {
        let cleanContent = content.replace(/```json\s*|\s*```/g, "");
        const firstBrace = cleanContent.indexOf('{');
        const lastBrace = cleanContent.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            cleanContent = cleanContent.substring(firstBrace, lastBrace + 1);
        }
        return JSON.parse(cleanContent);
    } catch (e) {
        console.error("JSON Parse Failed. Content Start:", content.substring(0, 200));
        return null;
    }
}
