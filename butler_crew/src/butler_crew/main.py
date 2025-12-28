"""FastAPI entry point for Butler Crew."""

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import litellm

from butler_crew.crew import ButlerCrew
from butler_crew.services.memory_service import MemoryService

# Load .env from root Butler folder (parent of butler_crew)
env_path = Path(__file__).resolve().parents[3] / ".env"
print(f"[DEBUG] Loading .env from: {env_path}")
print(f"[DEBUG] .env exists: {env_path.exists()}")
load_dotenv(dotenv_path=env_path, override=True)

# Configure litellm with OpenRouter API key
openrouter_key = os.getenv("OPENROUTER_API_KEY")
print(f"[DEBUG] OPENROUTER_API_KEY loaded: {'Yes (' + openrouter_key[:10] + '...)' if openrouter_key else 'No'}")
if openrouter_key:
    # Set the API key directly in litellm
    litellm.openrouter_api_key = openrouter_key
    os.environ["OPENROUTER_API_KEY"] = openrouter_key
else:
    print("[ERROR] OPENROUTER_API_KEY not found in .env!")


class CommandRequest(BaseModel):
    """Request model for processing commands."""
    user_message: str
    connection_id: str
    language: str = "en"
    devices: Optional[list] = None
    services: Optional[dict] = None
    rooms: Optional[list] = None
    client_timestamp: Optional[str] = None


# ... (Imports remain)
import logging

# ...

class CommandResponse(BaseModel):
    """Response model for processed commands."""
    text: str
    actions: list = []
    memory_saved: bool = False
    is_valid: bool = True
    rejection_message: Optional[str] = None
    logs: list[str] = [] # Added logs field

# ...

class ListLogHandler(logging.Handler):
    """Captures log records to a list."""
    def __init__(self):
        super().__init__()
        self.log_records = []
    
    def emit(self, record):
        try:
            msg = self.format(record)
            self.log_records.append(msg)
        except Exception:
            self.handleError(record)

@app.post("/process", response_model=CommandResponse)
async def process_command(request: CommandRequest):
    """
    Process a user command through the agent crew.
    """
    # Setup Log Capture
    log_capture = ListLogHandler()
    formatter = logging.Formatter('[%(name)s] %(levelname)s: %(message)s')
    log_capture.setFormatter(formatter)
    root_logger = logging.getLogger()
    root_logger.addHandler(log_capture)
    # Ensure we capture INFO level for this request
    original_level = root_logger.level
    root_logger.setLevel(logging.INFO)
    
    try:
        # Set user context for this request
        from butler_crew.context import set_current_user_id, reset_current_user_id
        token = set_current_user_id(request.connection_id)
        
        try:
            # Lazy-load the crew on first request
            crew = get_crew()
            
            print(f"[INFO] Processing command from {request.connection_id}: {request.user_message}")
            print(f"[INFO] Context: {len(request.devices or [])} devices, Language: {request.language}")

            # Build device context
            device_context = ""
            if request.devices:
                device_context = "\n".join(
                    f"- {d.get('entity_id', 'unknown')} ({d.get('attributes', {}).get('friendly_name', '')}): {d.get('state', 'unknown')}"
                    for d in request.devices
                )
            
            # Run the crew
            result = crew.kickoff(inputs={
                "user_message": request.user_message,
                "device_context": device_context,
                "language": request.language,
            })
            
            # Parse result (crew returns structured output)
            return CommandResponse(
                text=result.get("text", "Command processed."),
                actions=result.get("actions", []),
                memory_saved=result.get("memory_saved", False),
                is_valid=result.get("is_valid", True),
                rejection_message=result.get("rejection_message"),
                logs=log_capture.log_records # Return captured logs
            )
        finally:
            # Clean up context
            reset_current_user_id(token)
            
    except Exception as e:
        print(f"[ERROR] Logic Error processing command: {e}")
        import traceback
        traceback.print_exc()
        # Even in error, try to return logs if possible, but HTTPException usually interrupts.
        # We'll just rely on the server logs for hard crashes.
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # cleanup logging
        root_logger.removeHandler(log_capture)
        root_logger.setLevel(original_level)


@app.get("/agents")
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
