"""User memory tools for Butler agents."""

from typing import Any, Dict, Optional
from crewai.tools import tool
try:
    from butler_crew.services.memory_service import get_memory_service
except ImportError:
    # Fallback for circular imports or testing
    get_memory_service = None

from butler_crew.context import get_current_user_id

@tool("get_user_preferences")
def get_user_preferences(
    category: Optional[str] = None,
    key: Optional[str] = None
) -> str:
    """
    Get stored user preferences.
    """
    import json
    if not get_memory_service:
        return json.dumps({"error": "Memory Service not available"})
    
    try:
        mem = get_memory_service()
        connection_id = get_current_user_id() or "default"
        
        prefs = mem.get_preferences(connection_id=connection_id, category=category)
        
        # Filter by key if needed (Chroma only filters by category in our impl)
        if key:
            prefs = [p for p in prefs if p["key"] == key]
            
        return json.dumps(prefs)
    except Exception as e:
        return json.dumps({"error": str(e)})


@tool("save_user_preference")
def save_user_preference(
    category: str,
    key: str,
    value: Any,
    confirmed: bool = False
) -> str:
    """
    Save a user preference.
    """
    import json
    if not get_memory_service:
        return json.dumps({"error": "Memory Service not available"})

    try:
        mem = get_memory_service()
        connection_id = get_current_user_id() or "default"
        
        doc_id = mem.save_preference(
            connection_id=connection_id,
            category=category,
            key=key,
            value=value,
            confirmed=confirmed
        )
        return json.dumps({"status": "success", "id": doc_id})
    except Exception as e:
        return json.dumps({"error": str(e)})


@tool("get_name_clarifications")
def get_name_clarifications(user_term: str) -> str:
    """
    Look up what entity IDs a user term refers to.
    """
    import json
    if not get_memory_service:
        return json.dumps({"error": "Memory Service not available"})

    try:
        mem = get_memory_service()
        connection_id = get_current_user_id() or "default"
        
        # Exact lookup first
        exact = mem.lookup_clarification(connection_id, user_term)
        if exact:
            return json.dumps({"entity_ids": exact, "match_type": "exact"})
            
        # Fuzzy/Semantic search
        results = mem.search_clarifications(connection_id, user_term)
        return json.dumps({"results": results, "match_type": "semantic"})
    except Exception as e:
        return json.dumps({"error": str(e)})


@tool("save_name_clarification")
def save_name_clarification(
    user_term: str,
    entity_ids: list,
    context: Optional[str] = None
) -> str:
    """
    Save a name mapping from user term to entity IDs.
    """
    import json
    if not get_memory_service:
        return json.dumps({"error": "Memory Service not available"})

    try:
        mem = get_memory_service()
        connection_id = get_current_user_id() or "default"
        
        doc_id = mem.save_clarification(
            connection_id=connection_id,
            user_term=user_term,
            entity_ids=entity_ids,
            context=context
        )
        return json.dumps({"status": "success", "id": doc_id})
    except Exception as e:
        return json.dumps({"error": str(e)})


@tool("check_denied_proposals")
def check_denied_proposals(proposal_hash: str) -> str:
    """Check if an automation proposal has been denied."""
    import json
    # No SQL implementation yet, returning stub to not break
    return json.dumps({
        "status": "stub", 
        "message": "Proposal tracking not implemented in local memory yet."
    })

@tool("record_proposal_denial")
def record_proposal_denial(
    proposal_hash: str,
    proposal_summary: str
) -> str:
    """Record that a user denied an automation proposal."""
    import json
    return json.dumps({
        "status": "stub",
        "message": "Proposal tracking not implemented in local memory yet."
    })
