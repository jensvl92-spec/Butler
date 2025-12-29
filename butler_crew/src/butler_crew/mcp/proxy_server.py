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

import uuid
import time
import os

# --- MEMORY STORE ---
class MemoryStore:
    def __init__(self):
        # In HA Add-on, /data is persistent. Locally, we use ./data
        # We check for a typical Add-on environment variable or just existence of /data
        if os.path.exists("/data"):
            self.path = Path("/data/memory.json")
        else:
            self.path = Path("./data/memory.json")
            
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.memories: List[Dict[str, Any]] = self._load()

    def _load(self) -> List[Dict[str, Any]]:
        if self.path.exists():
            try:
                with open(self.path, "r") as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"Failed to load memory: {e}")
                return []
        return []

    def save_fact(self, text: str, metadata: Dict = None) -> Dict[str, Any]:
        entry = {
            "id": str(uuid.uuid4()),
            "text": text,
            "metadata": metadata or {},
            "timestamp": time.time()
        }
        self.memories.append(entry)
        self._persist()
        return entry

    def _persist(self):
        try:
            with open(self.path, "w") as f:
                json.dump(self.memories, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save memory: {e}")

memory_store = MemoryStore()

# --- SEMANTIC SEARCH ENGINE ---
class SearchEngine:
    def __init__(self):
        self.model = None
        self.is_ready = False
        
        # Entity Index
        self.entity_embeddings = None
        self.entity_ids = []
        self.entity_texts = [] 
        
        # Memory Index
        self.memory_embeddings = None
        self.memory_ids = []  # indices correspond to memory_store.memories

    def initialize(self):
        if not HAS_FASTEMBED:
            logger.warning("FastEmbed not installed. Semantic search will fallback to keyword matching.")
            return
        
        logger.info("Initializing FastEmbed Model...")
        # "BAAI/bge-small-en-v1.5" is excellent and tiny.
        self.model = TextEmbedding("BAAI/bge-small-en-v1.5")
        self.is_ready = True
        logger.info("FastEmbed Model Ready.")
        
        # Initial Memory Indexing
        self.index_memories()

    def index_inventory(self, entities: List[Dict[str, Any]]):
        if not self.is_ready:
            return

        self.entity_ids = []
        self.entity_texts = []
        
        for e in entities:
            eid = e["entity_id"]
            friendly = e.get("attributes", {}).get("friendly_name", "")
            text = f"{friendly} {eid} {e.get('state', '')}"
            
            self.entity_texts.append(text)
            self.entity_ids.append(eid)
            
        if self.entity_texts:
            logger.info(f"Embedding {len(self.entity_texts)} entities...")
            self.entity_embeddings = list(self.model.embed(self.entity_texts))
            logger.info("Entity Indexing complete.")

    def index_memories(self):
        """Re-indexes all memories from the store."""
        if not self.is_ready or not memory_store.memories:
            return

        texts = [m["text"] for m in memory_store.memories]
        logger.info(f"Embedding {len(texts)} memories...")
        self.memory_embeddings = list(self.model.embed(texts))
        self.memory_ids = [m["id"] for m in memory_store.memories]
        logger.info("Memory Indexing complete.")

    def search(self, query: str, top_k: int = 10, threshold: float = 0.4) -> List[Dict[str, Any]]:
        """Search Entities"""
        if not self.is_ready or not self.entity_embeddings:
            return self._keyword_search(query)

        return self._vector_search(query, self.entity_embeddings, self.entity_ids, INVENTORY["entities"], "entity_id", top_k, threshold)

    def search_memories(self, query: str, top_k: int = 5, threshold: float = 0.4) -> List[Dict[str, Any]]:
        """Search Memories"""
        if not self.is_ready or not self.memory_embeddings:
            # Fallback keyword
            return [m for m in memory_store.memories if query.lower() in m["text"].lower()]

        # We can't use the generic _vector_search easily because the lookup is different (list vs dict)
        # So implementing specific logic here or generalizing helper.
        import numpy as np
        
        query_embedding = list(self.model.embed([query]))[0]
        scores = []
        qt = np.array(query_embedding)
        
        for idx, emb in enumerate(self.memory_embeddings):
            et = np.array(emb)
            score = np.dot(qt, et)
            if score > threshold:
                scores.append((score, idx)) # Store index
        
        scores.sort(key=lambda x: x[0], reverse=True)
        
        results = []
        for s in scores[:top_k]:
            results.append(memory_store.memories[s[1]])
            
        return results

    def _vector_search(self, query, embeddings, ids, source_list, id_key, top_k, threshold):
        import numpy as np
        query_embedding = list(self.model.embed([query]))[0]
        scores = []
        qt = np.array(query_embedding)
        
        for idx, emb in enumerate(embeddings):
            et = np.array(emb)
            score = np.dot(qt, et)
            if score > threshold:
                scores.append((score, ids[idx]))
        
        scores.sort(key=lambda x: x[0], reverse=True)
        top_ids = [s[1] for s in scores[:top_k]]
        
        results = []
        for tid in top_ids:
            # Linear scan fallback (optimized map would be better but list is small < 1000)
            for item in source_list:
                if item[id_key] == tid:
                    results.append(item)
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
    Also builds the Local Semantic Search Index and Memory Index.
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
    
    # Ensure memories are ranked
    search_engine.index_memories()
    
    count = len(INVENTORY["entities"])
    mem_count = len(memory_store.memories)
    return f"Successfully synced {count} entities and {mem_count} memories."

# --- MEMORY TOOLS ---

@mcp.tool()
async def save_memory(text: str) -> str:
    """
    Saves a long-term memory or fact about the user or home.
    Use this to remember preferences, aliases, or specific instructions.
    Example: "The guest room is also called the Dungeon."
    """
    entry = memory_store.save_fact(text)
    
    # Incremental or full re-index? specific append is cheaper but full re-index is safer for now
    if search_engine.is_ready:
        # Optimization: In real prod, just embed the new one and append. 
        # For prototype, re-indexing is fast enough (<100ms for <1000 items)
        search_engine.index_memories()
        
    return f"Memory saved: '{text}' (ID: {entry['id']})"

@mcp.tool()
async def search_memory(query: str) -> str:
    """
    Retrieves stored memories relevant to the query.
    Call this when you need context about user preferences or aliases.
    Example: "What is the Dungeon?" -> Returns "The guest room is also called the Dungeon"
    """
    results = search_engine.search_memories(query)
    if not results:
        return "No relevant memories found."
    
    # Format nicely
    output = []
    for r in results:
        output.append(f"- {r['text']}")
    return "\n".join(output)

# --- PROPOSAL TOOLS ---

@mcp.tool()
async def deny_proposal(proposal_text: str, reason: str = "") -> str:
    """
    Records a denied automation proposal to prevent repetition.
    Call this when the user rejects an idea.
    """
    # Check if exists first (simple check)
    existing = search_engine.search_memories(proposal_text, top_k=1, threshold=0.9)
    
    if existing and existing[0].get("metadata", {}).get("type") == "denied_proposal":
        # Increment count
        entry = existing[0]
        meta = entry.get("metadata", {})
        count = meta.get("count", 1) + 1
        meta["count"] = count
        meta["last_denied"] = time.time()
        
        # In a real database we'd update. Here we append a new one or modify in place?
        # MemoryStore is list-based in memory.
        # Let's just find it in the list and update.
        for m in memory_store.memories:
            if m["id"] == entry["id"]:
                m["metadata"] = meta
                memory_store._persist()
                return f"Proposal denied count incremented to {count}."

    # New denial
    meta = {
        "type": "denied_proposal",
        "reason": reason,
        "count": 1,
        "created_at": time.time()
    }
    memory_store.save_fact(proposal_text, metadata=meta)
    
    # Re-index
    if search_engine.is_ready:
        search_engine.index_memories()
        
    return f"Proposal '{proposal_text}' recorded as denied."

@mcp.tool()
async def check_denied_proposals(proposal_text: str) -> str:
    """
    Checks if a similar automation has been denied before.
    Returns 'ALLOWED' or 'REJECTED: <reason>'.
    """
    results = search_engine.search_memories(proposal_text, top_k=3, threshold=0.85)
    
    for r in results:
        meta = r.get("metadata", {})
        if meta.get("type") == "denied_proposal":
            count = meta.get("count", 1)
            reason = meta.get("reason", "No reason given")
            
            # Policy: If denied 3+ times, hard reject.
            # If denied < 3 times, warn but allow? Or just report previous denial.
            if count >= 3:
                return f"REJECTED: Denied {count} times previously. Reason: {reason}"
            else:
                 return f"WARNING: This was denied {count} times before ({reason}). Proceed with caution."
                 
    return "ALLOWED"

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

# --- HTTP API WRAPPER ---
# Exposes MCP tools via HTTP so Supabase Edge Functions can call them remotely
# This is the bridge that enables remote access via Cloudflare Tunnel

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any
import uvicorn

api = FastAPI(
    title="Butler MCP Proxy API",
    description="HTTP wrapper for MCP tools - enables remote access from Supabase Edge Functions",
    version="1.2.0"
)

api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ToolRequest(BaseModel):
    """Request body for tool calls."""
    args: Dict[str, Any] = {}

class ToolResponse(BaseModel):
    """Response from tool calls."""
    success: bool
    result: Any = None
    error: str = None

# Map of tool names to their async functions
TOOL_REGISTRY = {
    "sync_with_home_assistant": sync_with_home_assistant,
    "get_lights": get_lights,
    "get_switches": get_switches,
    "get_climate": get_climate,
    "search_devices": search_devices,
    "execute_ha_service": execute_ha_service,
    "save_memory": save_memory,
    "search_memory": search_memory,
    "deny_proposal": deny_proposal,
    "check_denied_proposals": check_denied_proposals,
    "get_agents": get_agents,
}

@api.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "version": "1.2.0",
        "tools_available": list(TOOL_REGISTRY.keys()),
        "entities_cached": len(INVENTORY["entities"]),
        "memories_count": len(memory_store.memories),
        "search_ready": search_engine.is_ready
    }

@api.get("/tools")
async def list_tools():
    """List all available MCP tools."""
    tools = []
    for name, func in TOOL_REGISTRY.items():
        tools.append({
            "name": name,
            "description": func.__doc__ or "No description",
        })
    return {"tools": tools}

@api.post("/tools/{tool_name}")
async def call_tool(tool_name: str, request: ToolRequest):
    """
    Call an MCP tool by name with provided arguments.
    This is the main endpoint Supabase Edge Functions will use.
    """
    if tool_name not in TOOL_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found")
    
    tool_func = TOOL_REGISTRY[tool_name]
    
    try:
        logger.info(f"HTTP Tool Call: {tool_name} with args: {request.args}")
        result = await tool_func(**request.args)
        return ToolResponse(success=True, result=result)
    except Exception as e:
        logger.error(f"Tool '{tool_name}' failed: {e}", exc_info=True)
        return ToolResponse(success=False, error=str(e))

@api.post("/sync")
async def sync_endpoint():
    """Convenience endpoint to trigger HA sync."""
    result = await sync_with_home_assistant()
    return {"result": result}

# --- STARTUP ---
@api.on_event("startup")
async def startup_event():
    """Initialize search engine and sync on startup."""
    logger.info("Starting Butler MCP Proxy Server...")
    
    # Initialize search engine
    if not search_engine.is_ready:
        search_engine.initialize()
    
    # Auto-sync with HA on startup
    try:
        await sync_with_home_assistant()
    except Exception as e:
        logger.warning(f"Initial HA sync failed (will retry): {e}")
    
    # Sync to Supabase for remote AI access
    try:
        from butler_crew.services.supabase_sync import initial_sync, start_background_sync
        logger.info("Starting Supabase sync...")
        await initial_sync()
        await start_background_sync()
        logger.info("Supabase sync started (every 5 min)")
    except ImportError:
        logger.info("Supabase sync not available (missing config)")
    except Exception as e:
        logger.warning(f"Supabase sync failed: {e}")

if __name__ == "__main__":
    # Run FastAPI server on port 8000
    # MCP protocol is also available via mcp.run() but we prioritize HTTP for remote access
    logger.info("Starting Butler MCP Proxy on http://0.0.0.0:8000")
    uvicorn.run(api, host="0.0.0.0", port=8000, log_level="info")
