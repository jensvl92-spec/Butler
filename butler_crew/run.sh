#!/bin/bash
set -e

# Define the config path
CONFIG_PATH="/data/options.json"

# Helper to read from JSON config using jq
get_config() {
    jq --raw-output ".[\"$1\"] // empty" "$CONFIG_PATH"
}

echo "==========================================="
echo "   Butler MCP Proxy Server v1.2.0"
echo "==========================================="
echo "Python Version: $(python3 --version)"
echo "Current Directory: $(pwd)"
echo "PYTHONPATH: $PYTHONPATH"

# Read configuration
MCP_TOKEN=$(get_config 'mcp_token')
MCP_URL=$(get_config 'mcp_server_url')
TUNNEL_TOKEN=$(get_config 'cloudflare_tunnel_token')
LOG_LEVEL=$(get_config 'log_level')

echo "MCP URL: $MCP_URL"
echo "Log Level: $LOG_LEVEL"

# Export Environment Variables for the application
export HA_MCP_TOKEN="$MCP_TOKEN"
export HA_MCP_URL="$MCP_URL"
export LOG_LEVEL="$LOG_LEVEL"

# Verify Python modules are importable
echo "--- Verifying Python imports... ---"
python3 -c "import fastapi; print('✓ fastapi')" || echo "✗ fastapi import failed"
python3 -c "import uvicorn; print('✓ uvicorn')" || echo "✗ uvicorn import failed"
python3 -c "import yaml; print('✓ pyyaml')" || echo "✗ pyyaml import failed"
python3 -c "import requests; print('✓ requests')" || echo "✗ requests import failed"
python3 -c "from fastembed import TextEmbedding; print('✓ fastembed')" || echo "✗ fastembed import failed"

# Start Cloudflare Tunnel in background (if token provided)
if [ -n "$TUNNEL_TOKEN" ]; then
    echo ""
    echo "--- Starting Cloudflare Tunnel... ---"
    cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" &
    TUNNEL_PID=$!
    echo "Cloudflare Tunnel started (PID: $TUNNEL_PID)"
    echo "Remote access enabled via your Cloudflare Tunnel URL"
else
    echo ""
    echo "--- No Cloudflare Tunnel token provided ---"
    echo "MCP Proxy will only be accessible on local network (port 8000)"
    echo "For remote access, add your Cloudflare Tunnel token in add-on config"
fi

echo ""
echo "--- Starting MCP Proxy HTTP Server on port 8000... ---"
echo ""

# Run the Proxy Server with unbuffered output
exec python3 -u -m butler_crew.mcp.proxy_server
