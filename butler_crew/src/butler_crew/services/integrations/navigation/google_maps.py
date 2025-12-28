"""Google Maps integration provider."""

import asyncio
from datetime import datetime
from typing import Any, Dict, Optional
import os

import googlemaps

from butler_crew.services.integrations.base import (
    BaseNavigationService,
    DirectionsResult,
    ProviderType,
)


class GoogleMapsProvider(BaseNavigationService):
    """
    Google Maps Directions API integration.
    
    Requires API key with Directions API enabled.
    """
    
    provider = ProviderType.GOOGLE_MAPS
    
    def __init__(self):
        self._api_key = os.getenv("GOOGLE_MAPS_API_KEY")
        self._client: Optional[googlemaps.Client] = None
        if self._api_key:
            self._client = googlemaps.Client(key=self._api_key)
    
    async def authenticate(self, credentials: Dict[str, Any]) -> bool:
        """
        Authenticate with Google Maps API.
        
        Args:
            credentials: Dict containing 'api_key'
        """
        try:
            self._api_key = credentials.get("api_key") or os.getenv("GOOGLE_MAPS_API_KEY")
            if not self._api_key:
                raise ValueError("No API key provided")
            
            self._client = googlemaps.Client(key=self._api_key)
            return True
        except Exception as e:
            print(f"[GoogleMaps] Auth failed: {e}")
            return False

    async def _run_async(self, func, *args, **kwargs):
        """Run blocking googlemaps calls in a thread."""
        return await asyncio.to_thread(func, *args, **kwargs)
    
    async def get_directions(
        self,
        origin: str,
        destination: str,
        mode: str = "driving",
        departure_time: Optional[datetime] = None,
    ) -> DirectionsResult:
        """Get directions from Google Maps."""
        if not self._client:
            # Try re-auth with env var
            if not await self.authenticate({}):
                raise ValueError("Not authenticated. Set GOOGLE_MAPS_API_KEY.")
        
        try:
            # Prepare arguments
            kwargs = {
                "origin": origin,
                "destination": destination,
                "mode": mode,
                "departure_time": departure_time if departure_time else "now",
                "traffic_model": "best_guess"
            }
            
            # Run blocking call in thread
            routes = await self._run_async(self._client.directions, **kwargs)
            
            if not routes:
                return DirectionsResult(
                    origin=origin,
                    destination=destination,
                    distance_meters=0,
                    duration_seconds=0,
                    summary="No route found",
                    provider=self.provider,
                )
            
            # Parse first route (best match)
            route = routes[0]
            leg = route['legs'][0]
            
            return DirectionsResult(
                origin=leg['start_address'],
                destination=leg['end_address'],
                distance_meters=leg['distance']['value'],
                duration_seconds=leg['duration']['value'],
                duration_in_traffic_seconds=leg.get('duration_in_traffic', {}).get('value'),
                summary=route.get('summary', ''),
                steps=[s['html_instructions'] for s in leg['steps']],
                provider=self.provider,
            )
            
        except Exception as e:
            print(f"[GoogleMaps] Error getting directions: {e}")
            # Identify invalid key error to help user
            if "The provided API key is invalid" in str(e):
                 print("[GoogleMaps] CRITICAL: API Key is invalid.")
            
            return DirectionsResult(
                origin=origin,
                destination=destination,
                distance_meters=0,
                duration_seconds=0,
                summary=f"Error: {str(e)}",
                provider=self.provider,
            )
    
    async def get_eta(
        self,
        origin: str,
        destination: str,
        mode: str = "driving",
    ) -> int:
        """Get ETA in seconds."""
        result = await self.get_directions(origin, destination, mode)
        return result.duration_in_traffic_seconds or result.duration_seconds
    
    async def get_distance(
        self,
        origin: str,
        destination: str,
    ) -> int:
        """Get distance in meters."""
        result = await self.get_directions(origin, destination)
        return result.distance_meters

