// pattern-engine.ts
// Shared logic for "Automation Expert".
// Used by:
// 1. Weekly Cron (analyze-patterns)
// 2. On-Demand Chat (process-ai-command via Tool)

import { createClient } from "npm:@supabase/supabase-js@2.38.4"
import { HAConnection } from './types.ts'
import { chatCompletion, parseJSONResponse } from './llm-service.ts'

// @ts-ignore
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
// @ts-ignore
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

export interface PatternResult {
    title: string;
    description: string;
    ha_automation_data: any;
    confidence: number;
    suppressed?: boolean;
}

export class PatternEngine {
    private supabase;

    constructor() {
        this.supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    }

    async scanConnection(connection: HAConnection, days: number = 3): Promise<{ patterns: PatternResult[], eventCount: number, debugUrl: string }> {
        console.log(`🕵️‍♂️ Pattern Engine: Scanning ${connection.id} for last ${days} days...`);

        // 1. FETCH HISTORY (HA API)
        // Note: Future upgrade -> use 'device_history' table for speed.
        const { csv, count, debugUrl } = await this.fetchHAHistory(connection, days);
        if (!csv) return { patterns: [], eventCount: 0, debugUrl: debugUrl || "No URL" };

        console.log(`📊 Analysis Base: ${count} events.`);

        // 2. ANALYZE WITH LLM
        const patterns = await this.analyzeWithLLM(csv);

        // 3. FILTER & SUPPRESS
        const validPatterns: PatternResult[] = [];
        for (const p of patterns) {
            const isSuppressed = await this.checkSuppression(p.title);
            if (isSuppressed) {
                console.log(`🚫 Pattern Suppressed: "${p.title}" (Rejected >= 2 times)`);
            } else {
                validPatterns.push(p);
            }
        }

        return { patterns: validPatterns, eventCount: count, debugUrl };
    }

    private async fetchHAHistory(conn: HAConnection, days: number): Promise<{ csv: string | null, count: number, debugUrl: string }> {
        try {
            // Step 1: Get Actionable Entities via /api/states
            // We cannot use wildcards (light.*) in history API safely.
            const statesUrl = `${conn.api_url}/api/states`;
            const statesRes = await fetch(statesUrl, {
                headers: {
                    "Authorization": `Bearer ${conn.api_token}`,
                    "Content-Type": "application/json"
                }
            });

            let targetEntities: string[] = [];
            if (statesRes.ok) {
                const states = await statesRes.json();
                targetEntities = states
                    .map((s: any) => s.entity_id)
                    .filter((id: string) => /^(light|switch|cover|climate|lock)\./.test(id));
            }

            if (targetEntities.length === 0) {
                return { csv: null, count: 0, debugUrl: "No actionable entities found in /api/states" };
            }

            // Step 2: Query History for these entities
            const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
            const entityList = targetEntities.join(',');
            // Note: URL length limit might be hit if too many entities. 
            // If > 200 entities, we might need to chunk. keeping it simple for now (most homes < 100 actionable).
            const historyUrl = `${conn.api_url}/api/history/period/${startTime}?filter_entity_id=${entityList}&minimal_response&end_time=${new Date().toISOString()}`;

            console.log(`🌐 [PatternEngine] Fetching History for ${targetEntities.length} entities from: ${historyUrl}`);

            const res = await fetch(historyUrl, {
                headers: {
                    "Authorization": `Bearer ${conn.api_token}`,
                    "Content-Type": "application/json"
                }
            });

            if (!res.ok) return { csv: null, count: 0, debugUrl: historyUrl };

            const data = await res.json(); // Array of Arrays

            // Flatten & Simplify
            let events: any[] = [];
            if (Array.isArray(data)) {
                data.forEach((arr: any[]) => {
                    arr.forEach(e => {
                        // We only care about User Actions (roughly).
                        // It's hard to distinguish perfectly via API, but we look for state changes.
                        events.push(`${e.last_changed}: ${e.entity_id} = ${e.state}`);
                    });
                });
            }

            // Sort & Slice to fit Context
            events.sort();
            // Return CSV-ish block
            const csv = events.slice(-800).join('\n'); // Last 800 events max
            if (!csv) throw new Error("History API returned valid data but no known events were found.");
            return { csv, count: events.length, debugUrl: historyUrl };
        } catch (e: any) {
            console.error("Pattern Engine: Fetch Failed", e);
            throw new Error(`Failed to fetch history from Home Assistant: ${e.message || e}`);
        }
    }

    private async analyzeWithLLM(logs: string): Promise<any[]> {
        const systemPrompt = `
        You are an Automation Expert. Analyze these Home Assistant logs.
        Find REPEATED PATTERNS of user behavior that are NOT yet automated.
        
        CRITERIA:
        1. Repeated at least 3 times.
        2. Linked to specific context (Time, Trigger).
        3. Actionable (Light on, Cover closed).
        
        OUTPUT JSON:
        {
            "patterns": [
                {
                    "title": "Turn on Porch Light at Sunset",
                    "description": "You manually turn on 'light.porch' around 18:00 every day.",
                    "confidence": 0.95,
                    "ha_automation_data": { ...valid HA automation YAML/JSON... }
                }
            ]
        }
        Empty list if none.
        `;

        const content = await chatCompletion([
            { role: "system", content: systemPrompt },
            { role: "user", content: `Logs:\n${logs}` }
        ], 1000); // Higher token limit for complex automations

        const res = parseJSONResponse(content);
        return res?.patterns || [];
    }

    private async checkSuppression(title: string): Promise<boolean> {
        // "Lightweight Suppression": Count rejections in DB
        const { count } = await this.supabase
            .from('suggestions')
            .select('*', { count: 'exact', head: true })
            .eq('title', title)
            .eq('status', 'rejected');

        return (count || 0) >= 2;
    }
}
