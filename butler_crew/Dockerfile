FROM python:3.11-bookworm

# Install basic tools, dependencies, and cloudflared for remote tunnel access
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    jq \
    curl \
    dos2unix \
    && rm -rf /var/lib/apt/lists/*

# Install cloudflared for Cloudflare Tunnel (secure remote access)
# Detect architecture and download appropriate binary
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then \
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared; \
    else \
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared; \
    fi && \
    chmod +x /usr/local/bin/cloudflared

# Install Python dependencies
# NOTE: CrewAI removed - agents now run in Supabase Edge Functions
# This proxy only provides MCP tools via HTTP
RUN pip3 install --break-system-packages \
    mcp \
    pyyaml \
    numpy \
    uvicorn \
    fastapi \
    pydantic \
    requests \
    httpx \
    fastembed \
    chromadb

# Create app directory
WORKDIR /app

# Copy the current directory (butler_crew source) into the container
COPY . /app

# Set Python Path to include src
ENV PYTHONPATH=/app/src

# Make the run script executable and fix line endings
RUN dos2unix /app/run.sh && chmod a+x /app/run.sh

CMD [ "/app/run.sh" ]
