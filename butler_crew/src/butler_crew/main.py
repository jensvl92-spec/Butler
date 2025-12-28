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


class CommandResponse(BaseModel):
    """Response model for processed commands."""
    text: str
    actions: list = []
    memory_saved: bool = False
    is_valid: bool = True
    rejection_message: Optional[str] = None


# Global instances
memory_service: Optional[MemoryService] = None
butler_crew: Optional[ButlerCrew] = None


def get_crew() -> ButlerCrew:
    """Lazy-load the Butler crew on first request."""
    global butler_crew
    if butler_crew is None:
        butler_crew = ButlerCrew()
    return butler_crew


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize services on startup."""
    global memory_service
    
    # Initialize ChromaDB-based memory
    chroma_dir = os.getenv("CHROMA_PERSIST_DIRECTORY", "./data/chroma")
    memory_service = MemoryService(persist_directory=chroma_dir)
    
    # Crew is lazy-loaded on first request (faster startup)
    print("Butler Crew API ready. Crew will initialize on first request.")
    
    yield
    
    # Cleanup (if needed)
    pass


# Move app instantiation AFTER lifespan definition
app = FastAPI(
    title="Butler Crew API",
    description="Multi-agent Home Assistant control system",
    version="0.1.0",
    lifespan=lifespan,
)

from butler_crew.api.auth import router as auth_router
app.include_router(auth_router)


@app.get("/", response_class=HTMLResponse)
async def root():
    """Diagnostic homepage."""
    google_id = "✅ Configured" if os.getenv("GOOGLE_CLIENT_ID") else "❌ Missing"
    spotify_id = "✅ Configured" if os.getenv("SPOTIFY_CLIENT_ID") else "❌ Missing"
    weather_key = "✅ Configured" if os.getenv("OPENWEATHER_API_KEY") else "❌ Missing"
    
    # Safe HTML generation without f-string complexity
    html_content = """
    <html>
        <head>
            <title>Butler Crew API</title>
            <style>
                body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
                .status { padding: 10px; border-radius: 5px; margin-bottom: 10px; }
                .success { background-color: #d4edda; color: #155724; }
                .error { background-color: #f8d7da; color: #721c24; }
                .chat-box { border: 1px solid #ccc; height: 300px; overflow-y: scroll; padding: 10px; margin-top: 20px; background: #f9f9f9; }
                .message { margin-bottom: 10px; padding: 8px; border-radius: 5px; }
                .user { background-color: #e3f2fd; text-align: right; }
                .bot { background-color: #fff; border: 1px solid #eee; }
                .input-area { margin-top: 10px; display: flex; gap: 10px; }
                input[type="text"] { flex-grow: 1; padding: 10px; }
                button { padding: 10px 20px; background-color: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; }
                button:disabled { background-color: #ccc; }
                a { display: inline-block; margin-top: 10px; padding: 10px 20px; background-color: #6c757d; color: white; text-decoration: none; border-radius: 5px; font-size: 0.9em; }
            </style>
        </head>
        <body>
            <h1>🤖 Butler Crew API</h1>
            
            <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                <div class="status %GOOGLE_CLASS%">
                    Google: <strong>%GOOGLE_ID%</strong>
                </div>
                <div class="status %SPOTIFY_CLASS%">
                    Spotify: <strong>%SPOTIFY_ID%</strong>
                </div>
                <div class="status %WEATHER_CLASS%">
                    Weather: <strong>%WEATHER_KEY%</strong>
                </div>
            </div>

            <div style="margin-top: 10px;">
                <a href="/auth/login/google" target="_blank">Connect Google</a>
                <a href="/auth/login/spotify" target="_blank">Connect Spotify</a>
            </div>

            <h3>Test Interface</h3>
            <div class="chat-box" id="chat">
                <div class="message bot">Hello! I am your Butler. Credentials connected. Ask me anything!</div>
            </div>
            
            <div class="input-area">
                <input type="text" id="userInput" placeholder="Type a command (e.g., 'What is the traffic to work?')..." onkeypress="handleKey(event)">
                <button onclick="sendMessage()" id="sendBtn">Send</button>
            </div>

            <script>
                async function sendMessage() {
                    const input = document.getElementById('userInput');
                    const btn = document.getElementById('sendBtn');
                    const chat = document.getElementById('chat');
                    const text = input.value.trim();
                    
                    if (!text) return;
                    
                    // Add user message
                    chat.innerHTML += `<div class="message user">${text}</div>`;
                    input.value = '';
                    input.disabled = true;
                    btn.disabled = true;
                    btn.innerText = 'Thinking...';
                    chat.scrollTop = chat.scrollHeight;
                    
                    try {
                        const response = await fetch('/process', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                user_message: text,
                                connection_id: "web-test-user",
                                language: "en",
                                devices: [] // Mock empty devices for now
                            })
                        });
                        
                        const data = await response.json();
                        
                        // Add bot response
                        chat.innerHTML += `<div class="message bot">${data.text}</div>`;
                        
                        if (data.actions && data.actions.length > 0) {
                             chat.innerHTML += `<div class="message bot" style="font-size: 0.8em; color: #666;">Actions: ${JSON.stringify(data.actions)}</div>`;
                        }
                        
                    } catch (e) {
                        chat.innerHTML += `<div class="message bot error">Error: ${e.message}</div>`;
                    }
                    
                    input.disabled = false;
                    btn.disabled = false;
                    btn.innerText = 'Send';
                    input.focus();
                    chat.scrollTop = chat.scrollHeight;
                }

                function handleKey(e) {
                    if (e.key === 'Enter') sendMessage();
                }
            </script>
        </body>
    </html>
    """
    
    # Manually replace constraints to avoid f-string hell with JS
    html_content = html_content.replace("%GOOGLE_CLASS%", 'success' if 'Configured' in google_id else 'error')
    html_content = html_content.replace("%GOOGLE_ID%", google_id)
    html_content = html_content.replace("%SPOTIFY_CLASS%", 'success' if 'Configured' in spotify_id else 'error')
    html_content = html_content.replace("%SPOTIFY_ID%", spotify_id)
    html_content = html_content.replace("%WEATHER_CLASS%", 'success' if 'Configured' in weather_key else 'error')
    html_content = html_content.replace("%WEATHER_KEY%", weather_key)
    
    return html_content


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "version": "0.1.0"}


@app.post("/process", response_model=CommandResponse)
async def process_command(request: CommandRequest):
    """
    Process a user command through the agent crew.
    """
    try:
        # Set user context for this request
        from butler_crew.context import set_current_user_id, reset_current_user_id
        token = set_current_user_id(request.connection_id)
        
        try:
            # Lazy-load the crew on first request
            crew = get_crew()
            
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
            )
        finally:
            # Clean up context
            reset_current_user_id(token)
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
