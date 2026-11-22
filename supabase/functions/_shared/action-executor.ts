import { AIAction, HAConnection } from './types.ts';
import { callHAService, createHAAutomation, createHAScript, deleteHAAutomation } from './ha-api.ts';
import { fetchWithTimeout } from './model-registry.ts';

export async function executeActionMatrix(
    actions: AIAction[],
    connection: HAConnection,
    supabase: any
): Promise<AIAction[]> {
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

                await callHAService(connection, 'script', 'turn_on', { entity_id: `script.${id}` });
                console.log(`✅ Auto-started script: script.${id}`);

                return { ...action, data: { ...action.data, created_id: id, entity_id: `script.${id}` } };
            }

            // 4. Cancel Scheduled Action (UUID-safe + tenant-scoped)
            if (action.type === 'cancel_action') {
                const id = String(action.data?.id || action.entity_id || '').trim();
                if (!id) throw new Error("Missing ID for cancellation");
                const { error } = await supabase
                    .from('scheduled_actions')
                    .delete()
                    .eq('id', id)
                    .eq('connection_id', connection.id);
                if (error) throw error;
                return { ...action };
            }

            // 5. Energy Optimization
            if (action.service === 'energy.optimize_schedule') {
                const sbUrl = Deno.env.get('SUPABASE_URL')!;
                const sbKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

                const res = await fetchWithTimeout(`${sbUrl}/functions/v1/energy-scheduler/schedule`, {
                    method: 'POST',
                    headers: {
                        'apikey': Deno.env.get('SUPABASE_ANON_KEY') || sbKey,
                        'Authorization': `Bearer ${sbKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        connection_id: connection.id,
                        device_entity_id: action.entity_id,
                        duration_minutes: action.data?.duration_minutes || 60,
                        optimization: action.data?.optimization || { preference: "cheapest" },
                        description: "AI Scheduled Optimization"
                    })
                }, 20000);

                if (!res.ok) throw new Error(`Energy Scheduler failed: ${await res.text()}`);
                const result = await res.json();
                return { ...action, data: { ...action.data, result } };
            }

            // 6. Energy Pre-heat
            if (action.service === 'energy.preheat_check') {
                const sbUrl = Deno.env.get('SUPABASE_URL')!;
                const sbKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

                const res = await fetchWithTimeout(`${sbUrl}/functions/v1/energy-scheduler/preheat`, {
                    method: 'POST',
                    headers: {
                        'apikey': Deno.env.get('SUPABASE_ANON_KEY') || sbKey,
                        'Authorization': `Bearer ${sbKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        connection_id: connection.id,
                        climate_entity_id: action.entity_id
                    })
                }, 20000);

                if (!res.ok) throw new Error(`Energy Preheat failed: ${await res.text()}`);
                const result = await res.json();
                return { ...action, data: { ...action.data, result } };
            }

            // 7. Recipe Services
            if (action.service?.startsWith('recipe.')) {
                const recipeAction = action.service.replace('recipe.', '');
                const sbUrl = Deno.env.get('SUPABASE_URL')!;
                const sbKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

                const isGetActive = recipeAction === 'active';
                const endpoint = recipeAction === 'search' ? '/search'
                    : recipeAction === 'start' ? '/start'
                        : recipeAction === 'step' ? '/step'
                            : recipeAction === 'timer' ? '/timer'
                                : `/active?connection_id=${encodeURIComponent(connection.id)}`;

                const res = await fetchWithTimeout(`${sbUrl}/functions/v1/recipe-assistant${endpoint}`, {
                    method: isGetActive ? 'GET' : 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': Deno.env.get('SUPABASE_ANON_KEY') || sbKey,
                        'Authorization': `Bearer ${sbKey}`
                    },
                    ...(isGetActive ? {} : {
                        body: JSON.stringify({
                            connection_id: connection.id,
                            ...action.data
                        })
                    })
                }, 20000);

                if (!res.ok) throw new Error(`Recipe ${recipeAction} failed: ${await res.text()}`);
                const result = await res.json();
                return { ...action, data: { ...action.data, result } };
            }

            // 8. Emergency Services (Panic Mode)
            if (action.service?.startsWith('emergency.')) {
                const emergencyType = action.service.replace('emergency.', '');
                const { data: panicConfig } = await supabase
                    .from('panic_config')
                    .select('*')
                    .eq('connection_id', connection.id)
                    .single();

                const results: string[] = [];

                switch (emergencyType) {
                    case 'call_police':
                    case 'call_ambulance':
                    case 'call_fire': {
                        const numbers: Record<string, string> = {
                            'call_police': '112',
                            'call_ambulance': '112',
                            'call_fire': '112'
                        };
                        return {
                            ...action,
                            type: 'open_phone',
                            data: {
                                phone: panicConfig?.country_code === 'US' ? '911' : numbers[emergencyType],
                                message: `Emergency: ${emergencyType.replace('call_', '')}`
                            }
                        };
                    }

                    case 'lock_all':
                    case 'unlock_all': {
                        const locks = panicConfig?.door_locks || [];
                        const lockService = emergencyType === 'lock_all' ? 'lock' : 'unlock';
                        for (const lockId of locks) {
                            await callHAService(connection, 'lock', lockService, { entity_id: lockId });
                            results.push(`${lockService}ed ${lockId}`);
                        }
                        return { ...action, data: { results } };
                    }

                    case 'lights_on': {
                        const lights = panicConfig?.light_entities || [];
                        if (lights.length === 0) {
                            await callHAService(connection, 'light', 'turn_on', { entity_id: 'all', brightness: 255 });
                        } else {
                            for (const lightId of lights) {
                                await callHAService(connection, 'light', 'turn_on', { entity_id: lightId, brightness: 255 });
                            }
                        }
                        return { ...action, data: { message: 'All lights turned on' } };
                    }

                    case 'alert_family': {
                        const contacts = panicConfig?.emergency_contacts || [];
                        return {
                            ...action,
                            type: 'send_alerts',
                            data: {
                                contacts,
                                message: 'Emergency alert from Butler: Please check on your family member.'
                            }
                        };
                    }

                    case 'alarm': {
                        if (panicConfig?.alarm_entity) {
                            await callHAService(connection, 'siren', 'turn_on', { entity_id: panicConfig.alarm_entity });
                        }
                        return { ...action, data: { message: 'Alarm triggered' } };
                    }
                }

                return { ...action };
            }

            // 9. Standard Service Call
            if (!action.entity_id) throw new Error('Missing entity_id');

            let domain = action.domain || action.entity_id.split(".")[0];
            let service = action.service;

            if (service && service.includes('.')) {
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
            console.error(`Action Failed: ${action.type || action.service}`, e);
            return { ...action, error: e.message || String(e) };
        }
    }));
}

export async function scheduleActions(scheduledActions: any[], connectionId: string, supabase: any) {
    if (!scheduledActions || scheduledActions.length === 0) return;

    const inserts = scheduledActions.map(sa => {
        const delayMs = typeof sa.wait_ms === 'number'
            ? sa.wait_ms
            : typeof sa.delay_seconds === 'number'
                ? sa.delay_seconds * 1000
                : 0;
        const scheduledFor = sa.scheduled_for
            ? new Date(sa.scheduled_for).toISOString()
            : new Date(Date.now() + Math.max(0, delayMs)).toISOString();

        return {
            connection_id: connectionId,
            title: sa.title || "Scheduled Action",
            scheduled_for: scheduledFor,
            actions: sa.actions,
            status: 'pending'
        };
    });

    const { error } = await supabase.from('scheduled_actions').insert(inserts);
    if (error) {
        console.error("Failed to schedule actions", error);
        throw error;
    }
    console.log(`✅ Scheduled ${inserts.length} actions.`);
}
