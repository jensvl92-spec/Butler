#!/usr/bin/with-contenv bashio

# Read configuration from Add-on options
MCP_TOKEN=$(bashio::config 'mcp_token')
MCP_URL=$(bashio::config 'mcp_server_url')
LOG_LEVEL=$(bashio::config 'log_level')

bashio::log.info "--- Starting Butler Crew Proxy ---"
bashio::log.info "MCP URL: $MCP_URL"

# Export Environment Variables
export HA_MCP_TOKEN="$MCP_TOKEN"
export HA_MCP_URL="$MCP_URL"
export LOG_LEVEL="$LOG_LEVEL"

# Run the Proxy Server
# We point directly to the module
python3 -m butler_crew.mcp.proxy_server
