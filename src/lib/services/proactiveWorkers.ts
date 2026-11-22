/**
 * Proactive Backend Workers Client
 *
 * Allows both Butler AI (via tool calling) and the user (via the App UI)
 * to invoke and monitor all Supabase Edge Function proactive workers on demand
 * using the authenticated user's session JWT.
 */

import { supabase } from '../supabase';

export type ProactiveWorkerId =
    | 'morning-briefing'
    | 'daily-butler'
    | 'analyze-patterns'
    | 'detect-anomalies'
    | 'energy-scheduler'
    | 'learn-climate'
    | 'learn-energy'
    | 'learn-habits';

export interface ProactiveWorkerMeta {
    id: ProactiveWorkerId;
    name: string;
    icon: string;
    description: string;
    defaultSubpath?: string;
    defaultPayload?: Record<string, any>;
}

export const PROACTIVE_WORKERS: ProactiveWorkerMeta[] = [
    {
        id: 'morning-briefing',
        name: 'Ochtendbriefing',
        icon: '☀️',
        description: 'Stelt een actuele dagbriefing samen (weer, aanwezigheid, energie, gewoontes).'
    },
    {
        id: 'analyze-patterns',
        name: 'Patroonanalyse & Automatiseringen',
        icon: '🧠',
        description: 'Analyseert Home Assistant historiek en doet slimme automatiseringsvoorstellen.'
    },
    {
        id: 'detect-anomalies',
        name: 'Anomaliedetectie',
        icon: '🛡️',
        description: 'Detecteert afwijkend verbruik, open deuren of ongebruikelijke sensorwaarden.',
        defaultSubpath: '/detect'
    },
    {
        id: 'energy-scheduler',
        name: 'Energieplanner',
        icon: '⚡',
        description: 'Berekent de goedkoopste dynamische stroomuren voor laden of voorverwarmen.',
        defaultSubpath: '/windows'
    },
    {
        id: 'learn-habits',
        name: 'Gewoontes & Correlaties Leren',
        icon: '📊',
        description: 'Leert terugkerende patronen uit je gebruik en contextsnapshots.',
        defaultSubpath: '/learn'
    },
    {
        id: 'learn-climate',
        name: 'Klimaat & Opwarmsnelheid',
        icon: '🌡️',
        description: 'Berekent hoe snel elke kamer opwarmt per buitentemperatuur.'
    },
    {
        id: 'learn-energy',
        name: 'Laadsnelheid Leren',
        icon: '🔋',
        description: 'Kalibreert werkelijke laadsnelheden (kW) van voertuigen en batterijen.'
    },
    {
        id: 'daily-butler',
        name: 'Dagelijkse Butler Check',
        icon: '🤵',
        description: 'Voert een volledige huischeck uit (ochtend- of nachtronde).'
    }
];

export interface WorkerInvocationResult {
    success: boolean;
    worker: ProactiveWorkerId;
    data?: any;
    error?: string;
    durationMs: number;
}

export async function triggerProactiveWorker(
    workerId: ProactiveWorkerId,
    connectionId: string,
    extraPayload: Record<string, any> = {},
    subpathOverride?: string
): Promise<WorkerInvocationResult> {
    const started = Date.now();
    const meta = PROACTIVE_WORKERS.find(w => w.id === workerId);
    const subpath = subpathOverride !== undefined ? subpathOverride : (meta?.defaultSubpath || '');
    const fnPath = subpath ? `${workerId}${subpath}` : workerId;

    try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData?.session?.access_token) {
            return {
                success: false,
                worker: workerId,
                error: 'Niet ingelogd — log eerst in om proactieve workers uit te voeren.',
                durationMs: Date.now() - started
            };
        }

        const { data, error } = await supabase.functions.invoke(fnPath, {
            body: {
                connection_id: connectionId,
                ...(meta?.defaultPayload || {}),
                ...extraPayload
            }
        });

        if (error) {
            return {
                success: false,
                worker: workerId,
                error: error.message || 'Worker uitvoering mislukt.',
                durationMs: Date.now() - started
            };
        }

        return {
            success: true,
            worker: workerId,
            data,
            durationMs: Date.now() - started
        };
    } catch (e: any) {
        return {
            success: false,
            worker: workerId,
            error: e?.message || String(e),
            durationMs: Date.now() - started
        };
    }
}
