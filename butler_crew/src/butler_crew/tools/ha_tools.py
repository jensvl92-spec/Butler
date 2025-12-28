"""Home Assistant tools for Butler agents."""

from typing import Any, Dict, Optional
from crewai.tools import tool


@tool("call_ha_service")
def call_ha_service(
    domain: str,
    service: str,
    entity_id: str,
    data: Optional[Dict[str, Any]] = None
) -> str:
    """
    Call a Home Assistant service.
    
    Args:
        domain: Service domain (e.g., 'light', 'switch', 'automation')
        service: Service name (e.g., 'turn_on', 'turn_off', 'toggle')
        entity_id: Entity to control (e.g., 'light.kitchen')
        data: Optional additional service data
        
    Returns:
        JSON string with the action to execute
    """
    import json
    
    action = {
        "type": "call_service",
        "service": f"{domain}.{service}",
        "entity_id": entity_id,
    }
    if data:
        action["data"] = data
    
    # Return action for the system to execute
    # Actual HA API calls happen in the MCP layer
    return json.dumps({
        "status": "queued",
        "action": action,
        "message": f"Queued: {domain}.{service} on {entity_id}"
    })


@tool("get_device_states")
def get_device_states(entity_filter: Optional[str] = None) -> str:
    """
    Get current states of Home Assistant devices.
    
    Args:
        entity_filter: Optional filter (e.g., 'light.*', 'switch.kitchen*')
        
    Returns:
        JSON string with device states
    """
    import json
    
    # This is a stub - actual implementation connects to HA MCP
    # For now, return placeholder indicating the tool exists
    return json.dumps({
        "status": "stub",
        "message": "Device states will be fetched from HA MCP",
        "filter": entity_filter,
    })


@tool("get_device_history")
def get_device_history(
    entity_id: str,
    hours: int = 24
) -> str:
    """
    Get history for a specific device.
    
    Args:
        entity_id: Entity to get history for
        hours: Number of hours of history to fetch
        
    Returns:
        JSON string with device history
    """
    import json
    
    # Stub - connects to HA MCP
    return json.dumps({
        "status": "stub",
        "message": f"History for {entity_id} ({hours}h) will be fetched from HA MCP",
    })


@tool("create_automation")
def create_automation(
    alias: str,
    trigger: Dict[str, Any],
    action: Dict[str, Any],
    condition: Optional[Dict[str, Any]] = None,
    description: Optional[str] = None
) -> str:
    """
    Create a new Home Assistant automation.
    
    Args:
        alias: Name for the automation
        trigger: Trigger configuration
        action: Action configuration
        condition: Optional condition configuration
        description: Optional description
        
    Returns:
        JSON string with creation result
    """
    import json
    
    automation = {
        "alias": alias,
        "trigger": trigger,
        "action": action,
    }
    if condition:
        automation["condition"] = condition
    if description:
        automation["description"] = description
    
    # Stub - actual creation via HA MCP
    return json.dumps({
        "status": "stub",
        "message": f"Automation '{alias}' will be created via HA MCP",
        "automation": automation,
    })


@tool("delete_automation")
def delete_automation(entity_id: str) -> str:
    """
    Delete a Home Assistant automation.
    
    Args:
        entity_id: Automation entity ID to delete
        
    Returns:
        JSON string with deletion result
    """
    import json
    
    # Stub - actual deletion via HA MCP
    return json.dumps({
        "status": "stub",
        "message": f"Automation {entity_id} will be deleted via HA MCP",
    })
