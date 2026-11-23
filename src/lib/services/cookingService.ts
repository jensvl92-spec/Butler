/**
 * SOTA Interactive Step-by-Step Cooking Assistant (Client-Side Persistent)
 * - Zero latency, works offline during cooking
 * - Automatic keep-screen-on on Android while a recipe is active
 * - Intelligent ingredient portion scaling & per-step timer extraction
 */

import { setKeepScreenOn } from './deviceControlService';

export interface RecipeStep {
    instruction: string;
    timer_minutes?: number | null;
    tip?: string | null;
}

export interface ActiveRecipeSession {
    id: string;
    title: string;
    servings: number;
    baseServings: number;
    prepTime?: string;
    cookTime?: string;
    ingredients: string[];
    baseIngredients: string[];
    steps: RecipeStep[];
    currentStepIndex: number; // 0-based
    startedAt: string;
    sourceUrl?: string;
}

const STORAGE_KEY = 'butler_active_recipe_v1';

export function getActiveRecipeSession(): ActiveRecipeSession | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
        return parsed as ActiveRecipeSession;
    } catch {
        return null;
    }
}

function saveRecipeSession(session: ActiveRecipeSession | null): void {
    try {
        if (!session) {
            localStorage.removeItem(STORAGE_KEY);
            setKeepScreenOn(false).catch(() => {});
        } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
            setKeepScreenOn(true).catch(() => {});
        }
    } catch { }
}

/** Extracts an optional duration in minutes from a step instruction if none was explicitly provided */
function inferTimerMinutes(text: string): number | null {
    const m = text.match(/\b(\d{1,3})\s*(?:minuten|minuut|mins?|minutes?)\b/i);
    if (m) {
        const val = parseInt(m[1], 10);
        if (val > 0 && val <= 360) return val;
    }
    return null;
}

/** Scales numeric quantities at the start or inside an ingredient string */
function scaleIngredientLine(line: string, ratio: number): string {
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.01) return line;
    return line.replace(/(^|[\s(])(\d+(?:[.,]\d+)?)(?=\s|[a-zA-Z]|$)/g, (_m, prefix, numStr) => {
        const parsed = parseFloat(numStr.replace(',', '.'));
        if (!Number.isFinite(parsed)) return `${prefix}${numStr}`;
        const scaled = parsed * ratio;
        const rounded = scaled >= 10
            ? Math.round(scaled)
            : Math.round(scaled * 4) / 4;
        const formatted = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
        return `${prefix}${formatted}`;
    });
}

function formatStepPayload(session: ActiveRecipeSession) {
    const step = session.steps[session.currentStepIndex];
    const total = session.steps.length;
    const stepNumber = session.currentStepIndex + 1;
    return {
        active: true,
        recipe_id: session.id,
        title: session.title,
        servings: session.servings,
        prep_time: session.prepTime || null,
        cook_time: session.cookTime || null,
        step_number: stepNumber,
        total_steps: total,
        is_first_step: stepNumber === 1,
        is_last_step: stepNumber === total,
        current_step: step.instruction,
        suggested_timer_minutes: step.timer_minutes || null,
        tip: step.tip || null,
        ingredients: session.ingredients,
        source_url: session.sourceUrl || null
    };
}

export function executeCookingAssistant(args: {
    action: 'start_recipe' | 'next_step' | 'previous_step' | 'goto_step' | 'repeat_step' | 'get_status' | 'list_ingredients' | 'scale_servings' | 'finish_recipe';
    title?: string;
    servings?: number;
    prep_time?: string;
    cook_time?: string;
    ingredients?: string[];
    steps?: Array<string | RecipeStep>;
    step_number?: number;
    source_url?: string;
}) {
    const action = args.action;

    if (action === 'start_recipe') {
        const title = (args.title || '').trim();
        const rawSteps = Array.isArray(args.steps) ? args.steps : [];
        if (!title || rawSteps.length === 0) {
            return { error: 'Geef een titel en minstens één bereidingsstap mee om een recept te starten.' };
        }
        const steps: RecipeStep[] = rawSteps.map((st) => {
            if (typeof st === 'string') {
                return { instruction: st.trim(), timer_minutes: inferTimerMinutes(st) };
            }
            const instr = (st.instruction || '').trim();
            return {
                instruction: instr,
                timer_minutes: typeof st.timer_minutes === 'number' && st.timer_minutes > 0 ? st.timer_minutes : inferTimerMinutes(instr),
                tip: st.tip || null
            };
        }).filter(s => s.instruction.length > 0);

        const servings = Math.max(1, Math.round(Number(args.servings) || 2));
        const ingredients = Array.isArray(args.ingredients) ? args.ingredients.map(i => String(i).trim()).filter(Boolean) : [];

        const session: ActiveRecipeSession = {
            id: `recipe_${Date.now()}`,
            title,
            servings,
            baseServings: servings,
            prepTime: args.prep_time,
            cookTime: args.cook_time,
            ingredients,
            baseIngredients: [...ingredients],
            steps,
            currentStepIndex: 0,
            startedAt: new Date().toISOString(),
            sourceUrl: args.source_url
        };
        saveRecipeSession(session);
        return {
            ...formatStepPayload(session),
            message: `Kookmodus gestart voor "${title}" (${servings} personen, ${steps.length} stappen). Het scherm blijft automatisch aan.`
        };
    }

    const active = getActiveRecipeSession();
    if (!active) {
        return {
            active: false,
            message: 'Er is momenteel geen actief recept gestart. Vraag om een gerecht om de kookmodus te starten!'
        };
    }

    if (action === 'finish_recipe') {
        const finishedTitle = active.title;
        saveRecipeSession(null);
        return {
            active: false,
            finished: true,
            message: `Kookmodus voor "${finishedTitle}" afgerond. Smakelijk eten!`
        };
    }

    if (action === 'next_step') {
        if (active.currentStepIndex >= active.steps.length - 1) {
            return {
                ...formatStepPayload(active),
                reached_end: true,
                message: `Je bent al bij de laatste stap (${active.steps.length}/${active.steps.length}) van "${active.title}".`
            };
        }
        active.currentStepIndex += 1;
        saveRecipeSession(active);
        return formatStepPayload(active);
    }

    if (action === 'previous_step') {
        if (active.currentStepIndex > 0) {
            active.currentStepIndex -= 1;
            saveRecipeSession(active);
        }
        return formatStepPayload(active);
    }

    if (action === 'goto_step') {
        const idx = Math.max(0, Math.min(active.steps.length - 1, Math.round(Number(args.step_number) || 1) - 1));
        active.currentStepIndex = idx;
        saveRecipeSession(active);
        return formatStepPayload(active);
    }

    if (action === 'scale_servings') {
        const target = Math.max(1, Math.round(Number(args.servings) || active.servings));
        const ratio = target / active.baseServings;
        active.servings = target;
        active.ingredients = active.baseIngredients.map(line => scaleIngredientLine(line, ratio));
        saveRecipeSession(active);
        return {
            ...formatStepPayload(active),
            message: `Ingrediënten herberekend naar ${target} personen.`
        };
    }

    if (action === 'list_ingredients') {
        return {
            active: true,
            title: active.title,
            servings: active.servings,
            ingredients: active.ingredients,
            step_number: active.currentStepIndex + 1,
            total_steps: active.steps.length
        };
    }

    // repeat_step / get_status
    return formatStepPayload(active);
}
