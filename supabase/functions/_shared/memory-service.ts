import { createEmbedding } from './llm-service.ts'

export async function retrieveMemories(query: string, supabase: any): Promise<string> {
    try {
        const embedding = await createEmbedding(query);
        if (!embedding) return "";
        const { data: memories } = await supabase.rpc('match_memories', {
            query_embedding: embedding,
            match_threshold: 0.5,
            match_count: 5
        });
        if (memories && memories.length > 0) return memories.map((m: any) => `- ${m.content}`).join('\n');
    } catch (e) { /* ignore */ }
    return "";
}

export async function saveMemory(content: string, supabase: any) {
    try {
        const embedding = await createEmbedding(content);
        if (!embedding) return;
        await supabase.from('memories').insert({ content: content, embedding: embedding });
    } catch (e) { console.error("Memory Save Failed:", e); }
}

export async function saveChatHistory(req: any, res: any, actions: any[], supabase: any) {
    try {
        console.log(`💾 Saving Chat History for Connection: ${req.connection_id}`);
        // Sanitize AI Response to prevent huge payloads or invalid JSON
        const safeRes = {
            text: res.text || "",
            actions: res.actions || [],
            scheduled_actions: res.scheduled_actions || [],
            language: res.language || req.language
        };

        const payload = {
            connection_id: req.connection_id,
            user_message: req.user_message,

            // Fix: 'ai_response' seems to be TEXT column, so we must stringify the JSON object
            ai_response: JSON.stringify(safeRes),

            actions_taken: actions,

            // Fix: 'language' is a root column, NOT inside metadata
            language: req.language

            // Fix: 'metadata' column does NOT exist in the database, so we remove it.
            // model_reasoning is dropped since there's no column for it.
        };
        const { error } = await supabase.from('chat_history').insert(payload);
        if (error) {
            console.error("❌ DB Insert Failed:", error);
            return { success: false, error: error };
        } else {
            console.log("✅ Chat History Saved.");
            return { success: true };
        }
    } catch (e: any) {
        console.error("❌ Failed to save chat history (Exception):", e);
        return { success: false, error: e.message || e };
    }
}
