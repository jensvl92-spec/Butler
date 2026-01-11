-- Migration: Add RLS context setting for service-level user scoping
-- This allows Edge Functions to set a "current user" context that RLS policies can check

-- Create function to set the app-level user context
CREATE OR REPLACE FUNCTION public.set_app_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Set the user ID in a session-level variable
  PERFORM set_config('app.current_user_id', p_user_id::text, false);
END;
$$;

-- Grant execute to service role (Edge Functions use this)
GRANT EXECUTE ON FUNCTION public.set_app_user(uuid) TO service_role;

-- Add policy that allows service role queries when app.current_user_id is set
-- This is a defense-in-depth layer - even if code forgets .eq('user_id', x), RLS catches it

CREATE POLICY "Service role with app context can read tokens"
  ON public.user_tokens FOR SELECT
  TO service_role
  USING (
    user_id = COALESCE(
      NULLIF(current_setting('app.current_user_id', true), '')::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid  -- No match if not set
    )
  );

CREATE POLICY "Service role with app context can update tokens"
  ON public.user_tokens FOR UPDATE
  TO service_role
  USING (
    user_id = COALESCE(
      NULLIF(current_setting('app.current_user_id', true), '')::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  );

-- Force RLS for table owner (extra safety)
ALTER TABLE public.user_tokens FORCE ROW LEVEL SECURITY;
