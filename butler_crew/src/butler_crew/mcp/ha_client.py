"""Home Assistant MCP Client."""

from typing import Any, Dict, List, Optional
import os
import requests
import json

class HAMCPClient:
    """
    Client for connecting to Home Assistant's API (acting as MCP).
    """
    
    def __init__(
        self,
        url: Optional[str] = None,
        token: Optional[str] = None,
    ):
        """
        Initialize the HA MCP client.
        
        Args:
            url: Home Assistant URL (e.g., http://supervisor/core/api)
            token: Long-lived access token
        """
        # Auto-discovery for Add-on environment
        if not url and os.getenv("SUPERVISOR_TOKEN"):
             url = "http://supervisor/core/api"
        if not token:
             token = os.getenv("SUPERVISOR_TOKEN") or os.getenv("HA_TOKEN")
             
        # Fallback to defaults or env vars
        self.url = url or os.getenv("HA_URL", "http://homeassistant.local:8123/api")
        self.token = token
        
        self.headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        self._connected = False
        
        # Verify configuration
        if not self.token:
             print("[WARN] No HA Token found. HA Tools will be mocked.")

    
    def connect(self) -> bool:
        """
        Connect to the Home Assistant MCP server (verify auth).
        """
        try:
             if not self.token: return False
             resp = requests.get(f"{self.url}/", headers=self.headers, timeout=5)
             self._connected = resp.status_code == 200 or resp.status_code == 405 # API root might 405/404 but respond
             # Better check: /api/config
             resp = requests.get(f"{self.url}/config", headers=self.headers, timeout=5)
             self._connected = resp.status_code == 200
             return self._connected
        except Exception as e:
             print(f"[ERROR] Connection to HA failed: {e}")
             self._connected = False
             return False
    
    def disconnect(self):
        """Disconnect from the HA MCP server."""
        self._connected = False
    
    @property
    def is_connected(self) -> bool:
        """Check if connected."""
        return self._connected
    
    def list_tools(self) -> List[Dict[str, Any]]:
        """List available tools."""
        # This is static for now as we define the tools in Python, 
        # but technically we could fetch services from HA
        return [] 
    
    def call_tool(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Call a tool."""
        # We only really implement call_service for now via this generic interface
        if tool_name == "call_service":
             return self.call_service(**arguments)
        return {"status": "error", "message": "Unknown tool"}
    
    def call_service(
        self,
        domain: str,
        service: str,
        entity_id: str,
        data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Call an HA service via REST API.
        """
        if not self.token:
             return {"status": "mock", "message": f"MOCK: {domain}.{service} executed on {entity_id}"}
             
        try:
            payload = {"entity_id": entity_id}
            if data:
                 payload.update(data)
            
            endpoint = f"{self.url}/services/{domain}/{service}"
            resp = requests.post(endpoint, json=payload, headers=self.headers, timeout=10)
            
            if resp.status_code in [200, 201]:
                 return {
                     "status": "success", 
                     "message": f"Executed {domain}.{service} on {entity_id}", 
                     "data": resp.json()
                 }
            else:
                 return {
                     "status": "error", 
                     "message": f"HA API Error {resp.status_code}: {resp.text}"
                 }
                 
        except Exception as e:
             return {"status": "error", "message": str(e)}
    
    def get_states(
        self,
        entity_filter: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Get current entity states."""
        if not self.token: return []
        try:
             resp = requests.get(f"{self.url}/states", headers=self.headers, timeout=10)
             if resp.status_code == 200:
                  states = resp.json()
                  # Filter logic if needed, for now return all or let caller filter
                  return states
             return []
    def get_history(
        self,
        entity_id: str,
        hours: int = 24,
    ) -> List[Dict[str, Any]]:
        """Get entity history."""
        if not self.token: return []
        
        import datetime
        
        # Calculate start time
        start_time = datetime.datetime.now() - datetime.timedelta(hours=hours)
        timestamp = start_time.isoformat()
        
        try:
             # /api/history/period/<timestamp>?filter_entity_id=<entity_id>
             url = f"{self.url}/history/period/{timestamp}?filter_entity_id={entity_id}"
             resp = requests.get(url, headers=self.headers, timeout=10)
             
             if resp.status_code == 200:
                  # Returns a list of lists (one list per entity)
                  data = resp.json()
                  if data and isinstance(data, list) and len(data) > 0:
                      return data[0] # Return the history for the first (and only) entity
                  return []
             else:
                  print(f"[ERROR] Failed to fetch history: {resp.status_code}")
                  return []
        except Exception as e:
             print(f"[ERROR] History fetch exception: {e}")
             return []
