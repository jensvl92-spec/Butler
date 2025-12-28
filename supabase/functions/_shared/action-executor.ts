import { AIAction, HAConnection } from './types.ts'
import { callHAService, createHAAutomation, createHAScript, deleteHAAutomation } from './ha-api.ts'

export async function executeActionMatrix(actions: AIAction[], connection: HAConnection, supabase: any): Promise<AIAction[]> {
    return await Promise.all(actions.map(async (action) => {
        try {
            // 1. Create Automation
            if (action.type === 'create_automation') {
                const id = await createHAAutomation(connection, {
                    trigger: action.data?.trigger || [],
                    condition: action.data?.condition || [],
                    action: action.data?.action || [],
                    mode: "single"
                }, action.data?.alias || "AI Created Automation");
                return { ...action, data: { ...action.data, created_id: id } };
            }

            // 2. Delete Automation
            if (action.type === 'delete_automation') {
                if (!action.entity_id) throw new Error("Missing entity_id");
                await deleteHAAutomation(connection, action.entity_id);
                return { ...action };
            }

            // 3. Create Script
            if (action.type === 'create_script') {
                const id = await createHAScript(connection, {
                    sequence: action.data?.sequence || []
                }, action.data?.alias || "AI Script");

                // Execute immediately? Yes, usually.
                await callHAService(connection, 'script', 'turn_on', { entity_id: `script.${id}` });
                console.log(`✅ Auto-started script: script.${id}`);

                return { ...action, data: { ...action.data, created_id: id, entity_id: `script.${id}` } };
            }

            // 4. Cancel Scheduled Action
            if (action.type === 'cancel_action') {
                const id = action.data?.id || (action.entity_id ? parseInt(action.entity_id) : null);
                if (!id) throw new Error("Missing ID for cancellation");
                const { error } = await supabase.from('scheduled_actions').delete().eq('id', id);
                if (error) throw error;
                return { ...action };
            }

            // 5. Standard Service Call
            if (!action.entity_id) throw new Error('Missing entity_id');

            let domain = action.entity_id.split(".")[0];
            let service = action.service;

            if (service.includes('.')) {
                const parts = service.split('.');
                if (parts.length === 2) {
                    domain = parts[0];
                    service = parts[1];
                }
            }

            await callHAService(connection, domain, service, {
                entity_id: action.entity_id,
                ...action.data
            });

            return { ...action };

        } catch (e: any) {
            console.error(`Action Failed: ${action.type}`, e);
            return { ...action, error: e.message };
        }
    }));
}

export async function scheduleActions(scheduledActions: any[], connectionId: string, supabase: any) {
    if (!scheduledActions || scheduledActions.length === 0) return;

    const inserts = scheduledActions.map(sa => ({
        connection_id: connectionId,
        title: sa.title || "Scheduled Action",
        scheduled_for: new Date(Date.now() + (sa.wait_ms || 0)).toISOString(),
        actions: sa.actions,
        status: 'pending'
    }));

    const { error } = await supabase.from('scheduled_actions').insert(inserts);
    if (error) {
        console.error("Failed to schedule actions", error);
        throw error;
    }
    console.log(`✅ Scheduled ${inserts.length} actions.`);
}
