-- Fix RLS policy for mcp_resources to allow reading ALL resources
-- The current policy only allows reading resources with connection_id IS NULL
-- This fix allows reading resources for any connection_id

-- Drop the restrictive policy
DROP POLICY IF EXISTS "Anon can read global mcp_resources" ON mcp_resources;

-- Create a more permissive policy that allows reading all resources
-- (either global OR any specific connection)
CREATE POLICY "Anon can read all mcp_resources"
  ON mcp_resources FOR SELECT
  USING (true);  -- Allow reading all resources

-- Also ensure authenticated users can read
CREATE POLICY IF NOT EXISTS "Authenticated can read all mcp_resources"
  ON mcp_resources FOR SELECT
  TO authenticated
  USING (true);

-- Ensure INSERT/UPDATE works for service_role (should already exist but let's be safe)
-- The "Service role has full access" policy should handle this
