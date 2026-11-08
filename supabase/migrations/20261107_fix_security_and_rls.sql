-- Migration: Re-enable RLS on internal tables and fix user_tokens INSERT policy
-- Date: 2026-11-07

-- 1. Re-enable RLS on all tables previously disabled in 20241229000002_mcp_fix_rls.sql
ALTER TABLE public.device_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_raw_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.denied_proposals ENABLE ROW LEVEL SECURITY;

-- 2. Drop any legacy/conflicting policies if they exist
DROP POLICY IF EXISTS "service_role_all_device_inventory" ON public.device_inventory;
DROP POLICY IF EXISTS "service_role_all_mcp_tools" ON public.mcp_tools;
DROP POLICY IF EXISTS "service_role_all_agents" ON public.agents;
DROP POLICY IF EXISTS "service_role_all_user_memories" ON public.user_memories;
DROP POLICY IF EXISTS "service_role_all_mcp_raw_sync" ON public.mcp_raw_sync;
DROP POLICY IF EXISTS "service_role_all_denied_proposals" ON public.denied_proposals;

DROP POLICY IF EXISTS "authenticated_read_device_inventory" ON public.device_inventory;
DROP POLICY IF EXISTS "authenticated_read_mcp_tools" ON public.mcp_tools;
DROP POLICY IF EXISTS "authenticated_read_agents" ON public.agents;
DROP POLICY IF EXISTS "authenticated_own_user_memories" ON public.user_memories;
DROP POLICY IF EXISTS "authenticated_own_denied_proposals" ON public.denied_proposals;

-- 3. Service role full access policies
CREATE POLICY "service_role_all_device_inventory" ON public.device_inventory
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_mcp_tools" ON public.mcp_tools
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_agents" ON public.agents
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_user_memories" ON public.user_memories
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_mcp_raw_sync" ON public.mcp_raw_sync
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_denied_proposals" ON public.denied_proposals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. Scoped authenticated user policies
CREATE POLICY "authenticated_read_device_inventory" ON public.device_inventory
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated_read_mcp_tools" ON public.mcp_tools
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated_read_agents" ON public.agents
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated_own_user_memories" ON public.user_memories
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "authenticated_own_denied_proposals" ON public.denied_proposals
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 5. Fix user_tokens RLS: add missing INSERT policy for service_role
DROP POLICY IF EXISTS "Service role can insert tokens" ON public.user_tokens;
DROP POLICY IF EXISTS "Service role with app context can insert tokens" ON public.user_tokens;

CREATE POLICY "Service role can insert tokens"
  ON public.user_tokens FOR INSERT
  TO service_role
  WITH CHECK (true);

-- Also allow service role with app context to delete tokens if needed
DROP POLICY IF EXISTS "Service role with app context can delete tokens" ON public.user_tokens;
CREATE POLICY "Service role with app context can delete tokens"
  ON public.user_tokens FOR DELETE
  TO service_role
  USING (true);
