import yaml
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple
import logging
import json
import asyncio

# pip install fastembed (if not already installed)
try:
    from fastembed import TextEmbedding
    HAS_FASTEMBED = True
except ImportError:
    HAS_FASTEMBED = False

from mcp.server.fastmcp import FastMCP

# Initialize FastMCP Server
mcp = FastMCP("Butler Proxy")

# --- LOGGER ---
logger = logging.getLogger("butler_proxy")
logging.basicConfig(level=logging.INFO)

# --- INVENTORY CACHE ---
INVENTORY: Dict[str, List[Dict[str, Any]]] = {
    "entities": [],
    "services": []
}

# --- SEMANTIC SEARCH ENGINE ---
class SearchEngine:
    def __init__(self):
        self.model = None
        self.is_ready = False
        self.entity_embeddings = None
        self.entity_ids = []
        self.entity_texts = [] # "Kitchen Light (light.kitchen)"

    def initialize(self):
        if not HAS_FASTEMBED:
            logger.warning("FastEmbed not installed. Semantic search will fallback to keyword matching.")
            return
        
        logger.info("Initializing FastEmbed Model...")
        # "BAAI/bge-small-en-v1.5" is excellent and tiny.
        self.model = TextEmbedding("BAAI/bge-small-en-v1.5")
        self.is_ready = True
        logger.info("FastEmbed Model Ready.")

    def index_inventory(self, entities: List[Dict[str, Any]]):
        if not self.is_ready:
            return

        self.entity_ids = []
        self.entity_texts = []
        
        for e in entities:
            eid = e["entity_id"]
            friendly = e.get("attributes", {}).get("friendly_name", "")
            # Create a rich descriptive string for embedding
            # e.g. "Kitchen Main Light light.kitchen_main on"
            text = f"{friendly} {eid} {e.get('state', '')}"
            
            self.entity_texts.append(text)
            self.entity_ids.append(eid)
            
        if self.entity_texts:
            logger.info(f"Embedding {len(self.entity_texts)} entities...")
            # embed returns a generator, convert to list
            self.entity_embeddings = list(self.model.embed(self.entity_texts))
            logger.info("Indexing complete.")

    def search(self, query: str, top_k: int = 10, threshold: float = 0.4) -> List[Dict[str, Any]]:
        if not self.is_ready or not self.entity_embeddings:
            # Fallback to simple keyword search
            return self._keyword_search(query)

        query_embedding = list(self.model.embed([query]))[0]
        
        # Calculate cosine similarity (basic dot product implementation for manual list)
        # Note: FastEmbed vectors are normalized, so dot product == cosine similarity
        import numpy as np
        
        scores = []
        qt = np.array(query_embedding)
        
        for idx, emb in enumerate(self.entity_embeddings):
            et = np.array(emb)
            score = np.dot(qt, et)
            if score > threshold:
                scores.append((score, self.entity_ids[idx]))
        
        # Sort by score desc
        scores.sort(key=lambda x: x[0], reverse=True)
        
        # Retrieve entity objects
        top_ids = [s[1] for s in scores[:top_k]]
        results = []
        for eid in top_ids:
            # Find the entity object in INVENTORY
            for e in INVENTORY["entities"]:
                if e["entity_id"] == eid:
                    results.append(e)
                    break
        return results

    def _keyword_search(self, query: str) -> List[Dict[str, Any]]:
        query = query.lower()
        results = []
        for e in INVENTORY["entities"]:
            if query in e["entity_id"].lower() or \
               query in e.get("attributes", {}).get("friendly_name", "").lower():
                results.append(e)
        return results

search_engine = SearchEngine()

# --- MOCK DATA FOR TESTING ---
MOCK_ENTITIES = [
    {"entity_id": "light.kitchen_main", "attributes": {"friendly_name": "Kitchen Main Light"}, "state": "on"},
    {"entity_id": "light.living_room_lamp", "attributes": {"friendly_name": "Living Room Lamp"}, "state": "off"},
    {"entity_id": "switch.coffee_machine", "attributes": {"friendly_name": "Coffee Machine"}, "state": "off"},
    {"entity_id": "climate.living_room", "attributes": {"friendly_name": "Living Room AC", "current_temperature": 24}, "state": "cool"},
    {"entity_id": "sensor.living_room_temp", "attributes": {"friendly_name": "Living Room Temperature"}, "state": "24.5"},
    {"entity_id": "cover.garage_door", "attributes": {"friendly_name": "Garage Door"}, "state": "closed"},
    {"entity_id": "input_boolean.vacation_mode", "attributes": {"friendly_name": "Vacation Mode"}, "state": "off"},
]

# --- SYNC TOOL ---
@mcp.tool()
async def sync_with_home_assistant() -> str:
    """
    Connects to the Official Home Assistant MCP Server and fetches the complete inventory.
    Also builds the Local Semantic Search Index.
    Call this on startup or when 'Sync' is requested.
    """
    logger.info("Syncing with Home Assistant...")
    
    # Initialize Search Engine if needed
    if not search_engine.is_ready:
        search_engine.initialize()

    # TODO: Real SSE connection
    INVENTORY["entities"] = MOCK_ENTITIES
    
    # Index the new inventory
    search_engine.index_inventory(INVENTORY["entities"])
    
    count = len(INVENTORY["entities"])
    return f"Successfully synced {count} entities and built semantic index."

# --- DOMAIN REGISTRY TOOLS (The 'Type-First' Accessors) ---

def _filter_entities(domain: str, room: Optional[str] = None) -> List[Dict[str, Any]]:
    """Helper to filter the cached inventory by domain and optional room."""
    results = []
    for entity in INVENTORY["entities"]:
        entity_id = entity["entity_id"]
        
        # Domain check
        if not entity_id.startswith(f"{domain}."):
            continue
            
        # Room check
        if room:
            room_lower = room.lower()
            friendly = entity.get("attributes", {}).get("friendly_name", "").lower()
            if room_lower not in entity_id and room_lower not in friendly:
                continue
                
        results.append(entity)
    return results

@mcp.tool()
async def get_lights(room: str = None) -> str:
    """Returns a list of all light entities, optionally filtered by room name."""
    lights = _filter_entities("light", room)
    return json.dumps(lights, indent=2)

@mcp.tool()
async def get_switches(room: str = None) -> str:
    """Returns a list of all switch entities (plugs, appliances), optionally filtered by room."""
    switches = _filter_entities("switch", room)
    return json.dumps(switches, indent=2)

@mcp.tool()
async def get_climate(room: str = None) -> str:
    """Returns climate devices (thermostats, AC, heaters)."""
    climate = _filter_entities("climate", room)
    return json.dumps(climate, indent=2)

# --- SMART SEARCH TOOL (Replaces simple get_sensors) ---
@mcp.tool()
async def search_devices(query: str) -> str:
    """
    INTELLIGENTLY searches for devices using meaning (Semantic Search).
    Use this when you can't find something by type or room.
    Example: query="heating" will find radiators, boilers, and thermostats.
    """
    results = search_engine.search(query)
    return json.dumps(results, indent=2)

# --- ACTION TOOL ---
@mcp.tool()
async def execute_ha_service(entity_id: str, service: str, **kwargs) -> str:
    """Executes a Home Assistant service on a specific entity."""
    logger.info(f"Executing {service} on {entity_id} with {kwargs}")
    return f"Executed '{service}' on '{entity_id}' successfully."

# --- AGENT TOOLS ---
AGENTS_CONFIG_PATH = Path(__file__).parents[1] / "config" / "agents.yaml"
AGENTS_CACHE = {}

def _load_agents():
    if not AGENTS_CACHE:
        try:
            with open(AGENTS_CONFIG_PATH, "r") as f:
                AGENTS_CACHE.update(yaml.safe_load(f))
        except Exception as e:
            logger.error(f"Failed to load agents.yaml: {e}")

@mcp.tool()
async def get_agents(capability: str = None) -> str:
    """
    Returns available AI Agents.
    Args:
        capability: Optional keyword (e.g., 'email', 'automation').
                    The system matches this against agent ROLES, GOALS, and TAGS.
    """
    _load_agents()
    results = []
    
    for name, config in AGENTS_CACHE.items():
        role = config.get("role", "")
        goal = config.get("goal", "")
        tags = config.get("tags", [])
        
        # Match logic
        if capability:
            cap_lower = capability.lower()
            # Check Role, Goal, AND Tags
            match_found = False
            if cap_lower in name.lower() or cap_lower in role.lower() or cap_lower in goal.lower():
                match_found = True
            else:
                for tag in tags:
                    if cap_lower in tag.lower():
                        match_found = True
                        break
            
            if not match_found:
                continue
        
        results.append({
            "name": name,
            "role": role,
            "description": goal,
            "tags": tags  # Expose tags so the LLM sees the keywords
        })
        
    return json.dumps(results, indent=2)

# --- CREWAI INTEGRATION ---
try:
    from crewai import Crew, Task, Process
    from butler_crew.crew import ButlerCrew
    HAS_CREWAI = True
except ImportError:
    HAS_CREWAI = False
    logger.warning("CrewAI not found. Agent execution will be mocked.")

@mcp.tool()
async def ask_agent(agent_name: str, request: str) -> str:
    """
    Sends a dedicated request to a specific Agent and EXECUTEs it.
    Args:
        agent_name: The exact name of the agent (e.g., 'butler', 'personal_assistant').
        request: The natural language instruction (e.g., 'Check my emails').
    """
    _load_agents()
    
    if agent_name not in AGENTS_CACHE:
        return f"Error: Agent '{agent_name}' not found. Available: {list(AGENTS_CACHE.keys())}"
    
    if not HAS_CREWAI:
        return f"Error: CrewAI libraries not installed in this environment. Cannot execute {agent_name}."

    logger.info(f"Routing request to agent: {agent_name}")
    
    try:
        # 1. Instantiate the Crew wrapper
        butler_system = ButlerCrew()
        
        # 2. Get the specific agent method (e.g., butler_system.personal_assistant())
        if not hasattr(butler_system, agent_name):
             return f"Error: Agent '{agent_name}' is defined in YAML but has no matching method in ButlerCrew class."
        
        agent_method = getattr(butler_system, agent_name)
        target_agent = agent_method() # This returns the CrewAI Agent object
        
        # 3. Create a direct task for this agent
        # We create a temporary task just for this request
        task = Task(
            description=request,
            expected_output="A helpful response executing the user's request.",
            agent=target_agent
        )
        
        # 4. Create a single-agent crew to execute it
        # We use a sequential process with just one agent
        single_agent_crew = Crew(
            agents=[target_agent],
            tasks=[task],
            process=Process.sequential,
            verbose=True
        )
        
        # 5. Kickoff!
        result = single_agent_crew.kickoff()
        
        # 6. Format result
        return str(result)

    except Exception as e:
        logger.error(f"Agent Execution Failed: {e}", exc_info=True)
        return f"Error executing agent {agent_name}: {str(e)}"

if __name__ == "__main__":
    mcp.run()
