import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { executeActionMatrix } from '../_shared/action-executor.ts';
import { HAConnection, AIAction } from '../_shared/types.ts';
import { verifyRequestAuth, CORS_HEADERS } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) {
            return new Response(JSON.stringify({ error: auth.error }), {
                status: auth.status || 401,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        async function log(level: string, message: string, details?: any) {
            console.log(`[${level}] ${message}`, details || '');
            try {
                await supabase.from('scheduler_logs').insert({ level, message, details });
            } catch (err) {
                console.error("Log insert failed:", err);
            }
        }

        await log('info', "⏰ Scheduler Worker Started");

        // Resolve user's allowed connection IDs if triggered by a user JWT
        let allowedConnectionIds: string[] | null = null;
        if (!auth.isServiceOrCron && auth.userId) {
            const { data: userConns } = await supabase
                .from('ha_connections')
                .select('id')
                .eq('user_id', auth.userId);
            allowedConnectionIds = (userConns || []).map((c: any) => c.id);
            if (allowedConnectionIds.length === 0) {
                return new Response(JSON.stringify({ result: "no_tasks", processed: 0 }), {
                    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
                });
            }
        }

        // 1. Recover stale 'processing' tasks (older than 5 minutes based on locked_at/scheduled_for, capped at 3 retries)
        const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { data: staleTasks } = await supabase
            .from('scheduled_actions')
            .select('id, retry_count')
            .eq('status', 'processing')
            .lte('scheduled_for', staleThreshold);

        if (staleTasks && staleTasks.length > 0) {
            for (const st of staleTasks) {
                const retries = Number(st.retry_count || 0);
                if (retries >= 3) {
                    await supabase
                        .from('scheduled_actions')
                        .update({ status: 'failed', error: 'MAX_RETRIES_EXCEEDED' })
                        .eq('id', st.id);
                } else {
                    await supabase
                        .from('scheduled_actions')
                        .update({ status: 'pending', error: 'LEASE_EXPIRED_RETRY', retry_count: retries + 1 })
                        .eq('id', st.id);
                }
            }
        }

        // 2. Fetch & Lock Tasks due now or within the next 10 seconds
        const nowIso = new Date(Date.now() + 10000).toISOString();
        let lockQuery = supabase
            .from('scheduled_actions')
            .update({ status: 'processing', locked_at: new Date().toISOString(), error: null })
            .eq('status', 'pending')
            .lte('scheduled_for', nowIso);

        if (allowedConnectionIds) {
            lockQuery = lockQuery.in('connection_id', allowedConnectionIds);
        }

        const { data: grabbedTasks, error: fetchError } = await lockQuery
            .select('*, ha_connections(api_url, api_token, fcm_token)');

        if (fetchError) {
            await log('error', "DB Fetch/Lock Error", fetchError);
            throw fetchError;
        }

        if (!grabbedTasks || grabbedTasks.length === 0) {
            return new Response(JSON.stringify({ result: "no_tasks", processed: 0 }), {
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }

        await log('info', `⚡ Locked ${grabbedTasks.length} tasks for processing`);
        grabbedTasks.sort((a: any, b: any) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());
        const results: any[] = [];

        for (const task of grabbedTasks) {
            const delay = new Date(task.scheduled_for).getTime() - Date.now();
            if (delay > 0 && delay <= 5000) {
                await new Promise(r => setTimeout(r, delay));
            }

            const rawConn = task.ha_connections;
            if (!rawConn) {
                await log('error', `Connection not found for task ${task.id}`);
                await supabase.from('scheduled_actions').update({ status: 'failed', error: 'Connection not found' }).eq('id', task.id);
                results.push({ id: task.id, status: 'failed_no_connection' });
                continue;
            }

            const connection: HAConnection = {
                id: task.connection_id,
                api_url: rawConn.api_url,
                api_token: rawConn.api_token,
                fcm_token: rawConn.fcm_token
            };

            try {
                const actionResults = await executeActionMatrix((task.actions || []) as AIAction[], connection, supabase);
                const failedActions = actionResults.filter((a: any) => a?.error);
                if (failedActions.length > 0) {
                    const errMsg = failedActions.map((a: any) => `${a.entity_id || a.service || a.type}: ${a.error}`).join('; ');
                    throw new Error(errMsg);
                }

                await log('info', `✅ Executed: ${task.title}`);
                await supabase.from('scheduled_actions').update({
                    status: 'executed',
                    executed_at: new Date().toISOString(),
                    error: null
                }).eq('id', task.id);

                if (connection.fcm_token) {
                    try {
                        const { sendFCM } = await import("../_shared/firebase.ts");
                        await sendFCM(connection.fcm_token, `✅ Uitgevoerd: ${task.title}`, `Voltooid om ${new Date().toLocaleTimeString('nl-NL')}`);
                    } catch (pushErr) {
                        console.error('Push notification failed:', pushErr);
                    }
                }
                results.push({ id: task.id, status: 'success' });

            } catch (err: any) {
                await log('error', `Task ${task.id} execution failed`, { message: err?.message });

                if (connection.fcm_token) {
                    try {
                        const { sendFCM } = await import("../_shared/firebase.ts");
                        const actionPayload = JSON.stringify({ actions: task.actions, taskId: task.id });
                        await sendFCM(
                            connection.fcm_token,
                            `⚠️ Actie vereist: ${task.title}`,
                            `Cloud uitvoering mislukt. Tik om lokaal uit te voeren.`,
                            'EXECUTE_ACTION',
                            { type: 'EXECUTE_ACTION', payload: actionPayload }
                        );
                        await supabase.from('scheduled_actions').update({
                            status: 'failed',
                            error: `Delegated to Phone: ${err?.message || 'Error'}`
                        }).eq('id', task.id);
                        results.push({ id: task.id, status: 'delegated_to_phone' });
                        continue;
                    } catch (pushErr) {
                        console.error('FCM fallback delegation failed:', pushErr);
                    }
                }

                await supabase.from('scheduled_actions').update({
                    status: 'failed',
                    error: err?.message || 'Execution failed'
                }).eq('id', task.id);
                results.push({ id: task.id, status: 'failed', error: err?.message });
            }
        }

        return new Response(JSON.stringify({ result: "completed", processed: results.length, details: results }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });

    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }
});
