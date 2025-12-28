"""CrewAI tools for navigation operations."""

import json
import asyncio
from crewai.tools import tool

# Helper for async execution
def _run_async(coro):
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # If running in a loop (like uvicorn), we should ideally use run_in_executor
            # But for CrewAI tools which might be called from synchronous code, 
            # we need a way to run it. 
            # CAUTION: This is a hack for tools running inside an event loop.
            import nest_asyncio
            nest_asyncio.apply()
            return loop.run_until_complete(coro)
    except RuntimeError:
        pass
    return asyncio.run(coro)


@tool("get_directions")
def get_directions(
    origin: str,
    destination: str,
    mode: str = "driving",
) -> str:
    """
    Get directions and distance between two locations.
    
    Args:
        origin: Starting address or place name (or "current_location")
        destination: Ending address or place name
        mode: Travel mode - 'driving', 'walking', 'transit', or 'bicycling'
    """
    from butler_crew.services.integrations.navigation.google_maps import GoogleMapsProvider
    
    provider = GoogleMapsProvider()
    
    # Handle "current_location" - for now we just use a placeholder or handle in prompt
    # In a real app we'd get this from the client context
    if origin == "current_location":
        # Fallback or error if context not available
        return json.dumps({"error": "Current location not available provided via voice context yet."})

    try:
        result = _run_async(provider.get_directions(origin, destination, mode))
        
        return json.dumps({
            "origin": result.origin,
            "destination": result.destination,
            "distance_km": round(result.distance_meters / 1000, 1),
            "duration": f"{result.duration_in_traffic_seconds//60 if result.duration_in_traffic_seconds else result.duration_seconds//60} mins",
            "summary": result.summary,
            "steps": result.steps[:3] if result.steps else [], # Just first 3 steps to save tokens
            "provider": "google_maps"
        })
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})


@tool("get_eta")
def get_eta(destination: str, origin: str = "current_location") -> str:
    """
    Get estimated time of arrival to a destination.
    
    Args:
        destination: Destination address or place name
        origin: Starting point (default: "current_location")
    """
    # Reuse get_directions for simplicity
    return get_directions(origin, destination, mode="driving")


@tool("get_commute_time")
def get_commute_time(
    destination_type: str = "work",
) -> str:
    """
    Get commute time to a saved location (work, home, etc.).
    
    Args:
        destination_type: Type of saved location ('work', 'home', 'gym', etc.)
    """
    # Placeholder: In real usage we would look up the address for 'work' from User Memory
    # For now, just return a message that it requires setup
    return json.dumps({
        "action": "get_commute_time",
        "destination_type": destination_type,
        "status": "partial_success", 
        "message": f"To get commute to {destination_type}, please save your {destination_type} address first.",
        "commute_minutes": 0
    })
    
    
@tool("check_traffic")
def check_traffic(origin: str, destination: str) -> str:
    """
    Check current traffic conditions between two points.
    
    Args:
        origin: Starting point
        destination: Ending point
    """
    from butler_crew.services.integrations.navigation.google_maps import GoogleMapsProvider
    provider = GoogleMapsProvider()
    
    try:
        result = _run_async(provider.get_directions(origin, destination))
        
        traffic_duration = result.duration_in_traffic_seconds
        normal_duration = result.duration_seconds
        
        traffic_status = "normal"
        delay = 0
        
        if traffic_duration and normal_duration:
            diff = traffic_duration - normal_duration
            if diff > 300: # 5 mins
                traffic_status = "heavy"
                delay = diff // 60
            elif diff > 60:
                traffic_status = "moderate"
                delay = diff // 60
        
        return json.dumps({
            "status": "success",
            "traffic_level": traffic_status,
            "delay_minutes": delay,
            "duration_minutes": (traffic_duration or normal_duration) // 60
        })
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})

