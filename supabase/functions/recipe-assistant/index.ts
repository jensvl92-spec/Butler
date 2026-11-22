/**
 * Recipe Assistant - Hands-free cooking helper
 * Endpoints: POST /search, POST /start, POST /step, POST /timer, GET/POST /active, DELETE /clear
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from '../_shared/auth.ts';
import { chatCompletion, parseJSONResponse } from '../_shared/llm-service.ts';
import { fetchHAStates, callHAService } from '../_shared/ha-api.ts';
import { fetchWithTimeout } from '../_shared/model-registry.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY") || "";
const GOOGLE_CSE_ID = Deno.env.get("GOOGLE_CSE_ID") || "";

interface Recipe {
    name: string;
    servings: number;
    prepTime: string;
    cookTime: string;
    ingredients: string[];
    steps: string[];
    currentStep: number;
    source?: string;
    modifications?: string[];
}

function jsonResponse(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
}

function formatDurationHHMMSS(totalMinutes: number): string {
    const totalSec = Math.max(1, Math.round(totalMinutes * 60));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function searchRecipes(query: string): Promise<any[]> {
    if (GOOGLE_API_KEY && GOOGLE_CSE_ID) {
        try {
            const searchQuery = encodeURIComponent(`recipe ${query}`);
            const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${searchQuery}&num=5`;
            const response = await fetchWithTimeout(url, {}, 10000);
            if (response.ok) {
                const data = await response.json();
                return data.items?.map((item: any) => ({
                    title: item.title,
                    url: item.link,
                    snippet: item.snippet?.substring(0, 200)
                })) || [];
            }
        } catch (e) {
            console.error('[Recipe] Google search error:', e);
        }
    }
    return [];
}

async function generateRecipe(query: string, webResults: any[]): Promise<Recipe> {
    const webContext = webResults.length > 0
        ? `Online inspiration:\n${webResults.map(r => `- ${r.title}: ${r.snippet}`).join('\n')}`
        : 'Generate this recipe from your culinary knowledge with accurate measurements and cooking times.';

    const prompt = `You are a professional chef. Create a detailed, accurate recipe in the same language as the request for: "${query}"

${webContext}

Return ONLY valid JSON in this exact format:
{
    "name": "Recipe Name",
    "servings": 4,
    "prepTime": "15 min",
    "cookTime": "30 min",
    "ingredients": ["200g pasta", "4 eggs"],
    "steps": ["Step 1: ...", "Step 2: ..."],
    "source": "${webResults.length > 0 ? 'Inspired by online recipes' : 'Chef Butler'}"
}`;

    const content = await chatCompletion(
        [{ role: 'user', content: prompt }],
        2000,
        0.5,
        undefined,
        undefined,
        undefined,
        { effort: 'low' },
        'fast_interactive'
    );

    const parsed = parseJSONResponse(typeof content === 'string' ? content : JSON.stringify(content));
    if (!parsed || !Array.isArray(parsed.steps)) {
        throw new Error('Failed to generate valid recipe JSON');
    }
    parsed.currentStep = 0;
    return parsed as Recipe;
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/recipe-assistant/, '') || '/';

    try {
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) return jsonResponse({ error: auth.error }, auth.status || 401);

        let body: any = {};
        if (req.method !== 'GET' && req.method !== 'DELETE') {
            const raw = await req.text().catch(() => '');
            if (raw.trim()) {
                try { body = JSON.parse(raw); } catch { body = {}; }
            }
        }
        const connectionId = url.searchParams.get('connection_id') || body.connection_id;
        if (!connectionId) return jsonResponse({ error: 'connection_id required' }, 400);

        const ownership = await verifyConnectionOwnership(supabase, auth, connectionId);
        if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);
        const conn = ownership.connection;

        const nowIso = new Date().toISOString();

        if (path === '/search' && req.method === 'POST') {
            const query = body.query;
            if (!query) return jsonResponse({ error: 'query required' }, 400);
            const webResults = await searchRecipes(query);
            const recipe = await generateRecipe(query, webResults);
            return jsonResponse({ success: true, recipe, webSources: webResults.slice(0, 3) });
        }

        if (path === '/start' && req.method === 'POST') {
            const recipe = body.recipe as Recipe;
            if (!recipe || !Array.isArray(recipe.steps)) return jsonResponse({ error: 'valid recipe required' }, 400);
            recipe.currentStep = 0;
            const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

            await supabase
                .from('short_term_memory')
                .delete()
                .eq('connection_id', connectionId)
                .eq('context_type', 'recipe');

            await supabase.from('short_term_memory').insert({
                connection_id: connectionId,
                context_type: 'recipe',
                context_key: recipe.name,
                data: recipe,
                expires_at: expiresAt
            });

            return jsonResponse({
                success: true,
                message: `Recept "${recipe.name}" gestart (${recipe.ingredients?.length || 0} ingrediënten, ${recipe.steps.length} stappen).`,
                currentStep: 1,
                totalSteps: recipe.steps.length,
                firstStep: recipe.steps[0],
                ingredients: recipe.ingredients
            });
        }

        if (path === '/step' && req.method === 'POST') {
            const action = body.action || 'current';

            const { data: memory } = await supabase
                .from('short_term_memory')
                .select('*')
                .eq('connection_id', connectionId)
                .eq('context_type', 'recipe')
                .gt('expires_at', nowIso)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!memory) {
                return jsonResponse({
                    success: false,
                    message: "Geen actief recept gevonden."
                });
            }

            const recipe = memory.data as Recipe;
            let newStep = recipe.currentStep || 0;

            if (action === 'next') {
                newStep = Math.min(newStep + 1, recipe.steps.length - 1);
            } else if (action === 'prev' || action === 'previous' || action === 'back') {
                newStep = Math.max(newStep - 1, 0);
            } else if (typeof action === 'number' || !isNaN(parseInt(action, 10))) {
                newStep = Math.max(0, Math.min(parseInt(String(action), 10) - 1, recipe.steps.length - 1));
            }

            recipe.currentStep = newStep;
            await supabase
                .from('short_term_memory')
                .update({ data: recipe, updated_at: nowIso })
                .eq('id', memory.id);

            const isLastStep = newStep === recipe.steps.length - 1;
            return jsonResponse({
                success: true,
                recipeName: recipe.name,
                currentStep: newStep + 1,
                totalSteps: recipe.steps.length,
                stepText: recipe.steps[newStep],
                isLastStep,
                message: isLastStep
                    ? `Laatste stap! ${recipe.steps[newStep]}`
                    : `Stap ${newStep + 1} van ${recipe.steps.length}: ${recipe.steps[newStep]}`
            });
        }

        if (path === '/timer' && req.method === 'POST') {
            const minutes = Number(body.minutes || body.duration);
            const label = body.label || 'Kookwekker';
            if (!Number.isFinite(minutes) || minutes <= 0) {
                return jsonResponse({ error: 'valid positive minutes required' }, 400);
            }

            const durationStr = formatDurationHHMMSS(minutes);
            let haTimerStarted: string | null = null;

            try {
                let timerEntityId: string | undefined = body.entity_id;
                if (!timerEntityId) {
                    const states = await fetchHAStates(conn);
                    const timerEnt = states.find((s: any) => s.entity_id?.startsWith('timer.'));
                    timerEntityId = timerEnt?.entity_id;
                }
                if (timerEntityId) {
                    await callHAService(conn, 'timer', 'start', {
                        entity_id: timerEntityId,
                        duration: durationStr
                    });
                    haTimerStarted = timerEntityId;
                }
            } catch (e) {
                console.error('[Recipe] HA timer start failed:', e);
            }

            const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
            await supabase.from('short_term_memory').insert({
                connection_id: connectionId,
                context_type: 'timer',
                context_key: label,
                data: { minutes, duration: durationStr, label, haTimerStarted, startedAt: nowIso },
                expires_at: expiresAt
            });

            return jsonResponse({
                success: true,
                ha_timer: haTimerStarted,
                duration: durationStr,
                message: `Timer ingesteld op ${minutes} minuten (${label})${haTimerStarted ? ` via ${haTimerStarted}` : ''}.`
            });
        }

        if (path === '/active' && (req.method === 'GET' || req.method === 'POST')) {
            const { data: memory } = await supabase
                .from('short_term_memory')
                .select('*')
                .eq('connection_id', connectionId)
                .eq('context_type', 'recipe')
                .gt('expires_at', nowIso)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!memory) return jsonResponse({ active: false });

            const recipe = memory.data as Recipe;
            return jsonResponse({
                active: true,
                recipe,
                currentStep: (recipe.currentStep || 0) + 1,
                totalSteps: recipe.steps.length,
                currentStepText: recipe.steps[recipe.currentStep || 0]
            });
        }

        if (path === '/clear' && req.method === 'DELETE') {
            await supabase
                .from('short_term_memory')
                .delete()
                .eq('connection_id', connectionId)
                .eq('context_type', 'recipe');

            return jsonResponse({ success: true, message: 'Actief recept gewist.' });
        }

        return jsonResponse({ error: 'Endpoint not found', path }, 404);

    } catch (err: any) {
        console.error('[Recipe] Error:', err);
        return jsonResponse({ error: err.message }, 500);
    }
});
