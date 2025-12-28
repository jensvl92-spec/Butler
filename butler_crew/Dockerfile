FROM python:3.11-bookworm

# Install basic tools and dependencies
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    jq \
    curl \
    dos2unix \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies directly
# We perform a targeted install to ensure we have exactly what we need for the Proxy
RUN pip3 install --break-system-packages \
    mcp \
    pyyaml \
    numpy \
    uvicorn \
    fastapi \
    crewai \
    langchain \
    pydantic

# Create app directory
WORKDIR /app

# Copy the current directory (butler_crew source) into the container
COPY . /app

# Install the package itself in editable mode or just use PYTHONPATH
# Installing dependencies from pyproject.toml if needed, but we relied on manual pip above for speed/caching
# RUN pip3 install --break-system-packages .

# Set Python Path to include src
ENV PYTHONPATH=/app/src

# Make the run script executable and fix line endings
RUN dos2unix /app/run.sh && chmod a+x /app/run.sh

CMD [ "/app/run.sh" ]
