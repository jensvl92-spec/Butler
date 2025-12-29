#!/bin/bash
set -e

# Define the config path
CONFIG_PATH="/data/options.json"

# Helper to read from JSON config using jq (since we don't have bashio)
# Returns the value or an empty string if null/missing
get_config() {
    jq --raw-output ".[\"$1\"] // empty" "$CONFIG_PATH"
}

echo "--- Starting Butler Crew Proxy (Debian) ---"
echo "Python Version: $(python3 --version)"
echo "Current Directory: $(pwd)"
echo "PYTHONPATH: $PYTHONPATH"

# Read configuration
MCP_TOKEN=$(get_config 'mcp_token')
MCP_URL=$(get_config 'mcp_server_url')
LOG_LEVEL=$(get_config 'log_level')

echo "MCP URL: $MCP_URL"
echo "Log Level: $LOG_LEVEL"

# Export Environment Variables for the application
export HA_MCP_TOKEN="$MCP_TOKEN"
export HA_MCP_URL="$MCP_URL"
export LOG_LEVEL="$LOG_LEVEL"

# Verify Python modules are importable
echo "--- Verifying Python imports... ---"
python3 -c "import mcp; print('✓ mcp')" || echo "X mcp import failed"
python3 -c "import yaml; print('✓ pyyaml')" || echo "X pyyaml import failed"
python3 -c "import requests; print('✓ requests')" || echo "X requests import failed"
python3 -c "from mcp.server.fastmcp import FastMCP; print('✓ FastMCP')" || echo "X FastMCP import failed"

echo "--- Starting Proxy Server... ---"

# Run the Proxy Server module with unbuffered output
exec python3 -u -m butler_crew.mcp.proxy_server
