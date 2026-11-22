-- ============================================================================
-- Migration: 20261121000001_security_rls_and_schema_hardening.sql
-- Purpose:
--   1. Add missing columns needed for tenant isolation & reliable scheduling:
--      - memories.connection_id
--      - device_history.connection_id
--      - scheduled_actions.locked_at & retry_count
--      - ha_connections.fcm_token (if not already present)
--   2. Lock down ALL wide-open PUBLIC/anon RLS policies (`USING (true)`) across
--      tenant tables so every authenticated user can ONLY read/write rows owned
--      by their own `ha_connections` (user_id = auth.uid()).
--   3. Enable RLS on `user_preferences`, `user_memories`, `denied_proposals`,
--      `suggestions`, `automations`, `scheduled_actions`, `chat_history`,
--      `device_states`, `device_inventory`, `mcp_raw_sync`, `mcp_tools`,
--      `mcp_resources`, `behavior_patterns`, `behavior_correlations`,
--      `context_snapshots`, `anomaly_baselines`, `anomaly_events`,
--      `energy_schedules`, `charging_params`, `climate_heating_rates`,
--      `short_term_memory`, `panic_config`, `memories`, `device_history`.
--   4. Add missing INSERT policies on `automations` and `scheduled_actions`.
--   5. Ensure `suggestions` is part of `supabase_realtime` publication.
--   6. Clean up duplicate pg_cron jobs if pg_cron is installed.
-- ============================================================================

-- 1. Schema additions (idempotent)
ALTER TABLE IF EXISTS public.memories
    ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES public.ha_connections(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.device_history
    ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES public.ha_connections(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.scheduled_actions
    ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS public.ha_connections
    ADD COLUMN IF NOT EXISTS fcm_token TEXT;

-- Helper function: checks whether the current authenticated user owns a given connection_id
CREATE OR REPLACE FUNCTION public.user_owns_connection(p_connection_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.ha_connections c
        WHERE c.id = p_connection_id
          AND c.user_id = auth.uid()
    );
$$;

-- 2. Drop overly permissive PUBLIC/anon policies and apply strict tenant RLS
DO $$
DECLARE
    tbl TEXT;
    pol RECORD;
    conn_tables TEXT[] := ARRAY[
        'suggestions',
        'automations',
        'scheduled_actions',
        'chat_history',
        'user_memories',
        'denied_proposals',
        'user_preferences',
        'device_states',
        'device_inventory',
        'mcp_raw_sync',
        'mcp_tools',
        'mcp_resources',
        'behavior_patterns',
        'behavior_correlations',
        'context_snapshots',
        'anomaly_baselines',
        'anomaly_events',
        'energy_schedules',
        'charging_params',
        'climate_heating_rates',
        'short_term_memory',
        'panic_config',
        'memories',
        'device_history'
    ];
BEGIN
    FOREACH tbl IN ARRAY conn_tables LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = tbl
        ) THEN
            -- Enable RLS
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);

            -- Drop ALL existing policies on this table so no stale USING (true) policy survives
            FOR pol IN
                SELECT policyname FROM pg_policies
                WHERE schemaname = 'public' AND tablename = tbl
            LOOP
                EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, tbl);
            END LOOP;

            -- Service role always has full access (for Edge Functions / Cron workers)
            EXECUTE format(
                'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                tbl || '_service_role_all', tbl
            );

            -- Authenticated users can only access rows belonging to their own ha_connections
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'connection_id'
            ) THEN
                -- Special case for mcp_tools / mcp_resources: allow reading global rows (connection_id IS NULL)
                IF tbl IN ('mcp_tools', 'mcp_resources') THEN
                    EXECUTE format(
                        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (connection_id IS NULL OR public.user_owns_connection(connection_id))',
                        tbl || '_auth_select', tbl
                    );
                    EXECUTE format(
                        'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.user_owns_connection(connection_id))',
                        tbl || '_auth_insert', tbl
                    );
                    EXECUTE format(
                        'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.user_owns_connection(connection_id)) WITH CHECK (public.user_owns_connection(connection_id))',
                        tbl || '_auth_update', tbl
                    );
                    EXECUTE format(
                        'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.user_owns_connection(connection_id))',
                        tbl || '_auth_delete', tbl
                    );
                ELSE
                    EXECUTE format(
                        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.user_owns_connection(connection_id)) WITH CHECK (public.user_owns_connection(connection_id))',
                        tbl || '_auth_owner_all', tbl
                    );
                END IF;
            END IF;
        END IF;
    END LOOP;
END $$;

-- 3. Lock down scheduler_logs (internal service_role only; prevent cross-tenant log leaks)
DO $$
DECLARE
    pol RECORD;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'scheduler_logs') THEN
        ALTER TABLE public.scheduler_logs ENABLE ROW LEVEL SECURITY;
        FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scheduler_logs' LOOP
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.scheduler_logs', pol.policyname);
        END LOOP;
        CREATE POLICY scheduler_logs_service_only ON public.scheduler_logs
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

-- 4. Ensure suggestions is included in Realtime publication
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'suggestions'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.suggestions;
        END IF;
    END IF;
END $$;

-- 5. Deduplicate legacy pg_cron jobs if pg_cron extension is active
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        DELETE FROM cron.job a
        USING cron.job b
        WHERE a.jobid > b.jobid
          AND a.jobname IS NOT NULL
          AND a.jobname = b.jobname;
    END IF;
EXCEPTION WHEN OTHERS THEN
    -- Ignore if cron schema permissions differ in hosted environment
    NULL;
END $$;
