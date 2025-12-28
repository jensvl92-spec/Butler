#!/bin/bash

# Define the config path
CONFIG_PATH="/data/options.json"

# Helper to read from JSON config using jq (since we don't have bashio)
# Returns the value or an empty string if null/missing
get_config() {
    jq --raw-output ".[\"$1\"] // empty" "$CONFIG_PATH"
}

echo "--- Starting Butler Crew Proxy (Debian) ---"

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

# Run the Proxy Server module
# Explicitly using python3
python3 -m butler_crew.mcp.proxy_server
