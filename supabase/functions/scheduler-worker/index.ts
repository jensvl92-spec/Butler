import "jsr:@supabase/functions-js/edge-runtime.d.ts"
// @ts-ignore
import { createClient } from "npm:@supabase/supabase-js@2.38.4"
import { executeActionMatrix } from '../_shared/action-executor.ts'
import { HAConnection, AIAction } from '../_shared/types.ts'

// @ts-ignore
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
// @ts-ignore
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

// @ts-ignore
Deno.serve(async (req: Request) => {
    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        async function log(level: string, message: string, details?: any) {
            console.log(`[${level}] ${message}`, details || '');
            try {
                await supabase.from('scheduler_logs').insert({ level, message, details });
            } catch (err) {
                console.error("Log insert failed:", err);
            }
        }

        await log('info', "⏰ Scheduler Worker Started");

        // 1. Recover stale 'processing' tasks (older than 5 minutes) so they are not lost forever
        const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        await supabase
            .from('scheduled_actions')
            .update({ status: 'pending', error: 'LEASE_EXPIRED_RETRY' })
            .eq('status', 'processing')
            .lte('scheduled_for', staleThreshold);

        // 2. Fetch & Lock Tasks due now or within the next 10 seconds
        const nowIso = new Date(Date.now() + 10000).toISOString();
        const { data: grabbedTasks, error: fetchError } = await supabase
            .from('scheduled_actions')
            .update({ status: 'processing', error: null })
            .eq('status', 'pending')
            .lte('scheduled_for', nowIso)
            .select('*, ha_connections(api_url, api_token, fcm_token)');

        if (fetchError) {
            await log('error', "DB Fetch/Lock Error", fetchError);
            throw fetchError;
        }

        if (!grabbedTasks || grabbedTasks.length === 0) {
            await log('info', "💤 No tasks due for processing.");
            return new Response(JSON.stringify({ result: "no_tasks" }), { headers: { "Content-Type": "application/json" } });
        }

        await log('info', `⚡ Locked ${grabbedTasks.length} tasks for processing`);
        grabbedTasks.sort((a: any, b: any) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());
        const results: any[] = [];

        for (const task of grabbedTasks) {
            const delay = new Date(task.scheduled_for).getTime() - Date.now();
            await log('info', `Processing Task: ${task.title}`, { delay_ms: delay, scheduled_for: task.scheduled_for });

            // Short pause if due in 1-5 seconds
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

            // Map to Interface
            const connection: HAConnection = {
                id: task.connection_id,
                api_url: rawConn.api_url,
                api_token: rawConn.api_token,
                fcm_token: rawConn.fcm_token
            };

            try {
                // EXECUTE via Shared Matrix
                await executeActionMatrix(task.actions as AIAction[], connection, supabase);

                await log('info', `✅ Executed: ${task.title}`);
                await supabase.from('scheduled_actions').update({
                    status: 'executed',
                    executed_at: new Date().toISOString(),
                    error: null
                }).eq('id', task.id);

                if (connection.fcm_token) {
                    try {
                        const { sendFCM } = await import("../_shared/firebase.ts");
                        await sendFCM(connection.fcm_token, `✅ Acted: ${task.title}`, `Executed at ${new Date().toLocaleTimeString()}`);
                    } catch (pushErr) {
                        console.error('Push notification failed:', pushErr);
                    }
                }
                results.push({ id: task.id, status: 'success' });

            } catch (err: any) {
                await log('error', `Task ${task.id} execution failed`, err);

                // HYBRID FALLBACK: Delegate to Phone via FCM if cloud execution failed
                if (connection.fcm_token) {
                    try {
                        const { sendFCM } = await import("../_shared/firebase.ts");
                        const actionPayload = JSON.stringify({ actions: task.actions, taskId: task.id });
                        await sendFCM(
                            connection.fcm_token,
                            `⚠️ Action Required: ${task.title}`,
                            `Cloud failed. Tap to execute locally.`,
                            'EXECUTE_ACTION',
                            { type: 'EXECUTE_ACTION', payload: actionPayload }
                        );
                        await supabase.from('scheduled_actions').update({
                            status: 'failed',
                            error: 'Delegated to Phone'
                        }).eq('id', task.id);
                        results.push({ id: task.id, status: 'delegated_to_phone' });
                        continue;
                    } catch (pushErr) {
                        console.error('FCM fallback delegation failed:', pushErr);
                    }
                }

                await supabase.from('scheduled_actions').update({
                    status: 'failed',
                    error: err.message || 'Execution failed'
                }).eq('id', task.id);
                results.push({ id: task.id, status: 'failed', error: err.message });
            }
        }

        return new Response(JSON.stringify({ result: "completed", processed: results.length, details: results }), {
            headers: { "Content-Type": "application/json" }
        });

    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
});
