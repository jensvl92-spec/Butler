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
    Call a Home Assistant service immediately.
    
    Args:
        domain: Service domain (e.g., 'light', 'switch', 'automation')
        service: Service name (e.g., 'turn_on', 'turn_off', 'toggle')
        entity_id: Entity to control (e.g., 'light.kitchen')
        data: Optional additional service data
        
    Returns:
        JSON string with execution result
    """
    import json
    from butler_crew.mcp.ha_client import HAMCPClient
    
    client = HAMCPClient()
    # Ensure connection (checks env vars)
    if not client.connect():
         return json.dumps({
             "status": "error", 
             "message": "Could not connect to Home Assistant MCP Client. Check configuration."
         })
         
    result = client.call_service(domain, service, entity_id, data)
    
    # Return result so the Agent knows it happened
    return json.dumps(result)


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
    from butler_crew.mcp.ha_client import HAMCPClient
    
    client = HAMCPClient()
    if client.connect():
        # This returns ALL states if filter is None
        states = client.get_states(entity_filter)
        return json.dumps(states)
        
    return json.dumps({
        "status": "error",
        "message": "Could not connect to HA MCP"
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
    
    import json
    from butler_crew.mcp.ha_client import HAMCPClient
    
    client = HAMCPClient()
    if client.connect():
        history = client.get_history(entity_id, hours)
        # Summarize history to save tokens
        summary = []
        for state in history:
             summary.append(f"{state.get('last_changed')}: {state.get('state')}")
        
        # Limit to last 50 changes to avoid overflowing context
        return json.dumps(summary[-50:])
        
    return json.dumps({
        "status": "error",
        "message": "Could not connect to HA MCP"
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
    import yaml
    
    # Construct the automation object
    automation_config = {
        "alias": alias,
        "trigger": trigger,
        "action": action,
        "mode": "single"
    }
    if condition:
        automation_config["condition"] = condition
    if description:
        automation_config["description"] = description
        
    # Generate YAML
    yaml_str = yaml.dump([automation_config], sort_keys=False, indent=2)
    
    # In a real Add-on with /config access, we could append to automations.yaml
    # For now, we return the YAML for the Agent to present to the user
    return json.dumps({
        "status": "success",
        "message": "Automation logic generated.",
        "yaml_code": yaml_str,
        "instruction": "Add this YAML to your automations.yaml file or create a new automation in HA."
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
    
    return json.dumps({
        "status": "success",
        "message": "Deletion request acknowledged.",
        "instruction": f"To complete deletion, please remove automation '{entity_id}' from your 'automations.yaml' or Home Assistant UI settings."
    })
