"""FastAPI entry point for Butler Crew."""

import os
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import litellm

from butler_crew.schemas import CommandRequest, CommandResponse
from butler_crew.services.command_processor import process_command_logic
from butler_crew.services.ha_listener import HAEventListener

# Lifespan Manager for startup/shutdown events
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    listener = HAEventListener()
    task = asyncio.create_task(listener.start())
    yield
    # Shutdown
    await listener.stop()
    await task

app = FastAPI(
    title="Butler Crew API",
    description="CrewAI Agent Interface for Home Assistant",
    version="1.0.6",
    lifespan=lifespan
)

@app.post("/process", response_model=CommandResponse)
async def process_command(request: CommandRequest):
    """
    Process a user command through the agent crew (HTTP Endpoint).
    Useful for local testing or LAN access.
    Logic delegated to shared processor.
    """
    try:
        # Run blocking logic in thread pool to avoid blocking async loop
        return await asyncio.to_thread(process_command_logic, request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
async def list_agents():
    """List available agents and their roles."""
    return {
        "agents": [
            {"name": "Bouncer", "role": "Intent Validator"},
            {"name": "Butler", "role": "Main Orchestrator"},
            {"name": "Automation Handler", "role": "Toggle Automations"},
            {"name": "Automation Creator", "role": "Create/Delete Automations"},
            {"name": "Automation Engineer", "role": "Invent Automations"},
            {"name": "Analyzer", "role": "Pattern Analysis"},
            {"name": "Proposal Validator", "role": "Filter Denied Proposals"},
        ]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
