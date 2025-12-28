"""Spotify integration provider."""

import os
from typing import Dict, List, Optional
from butler_crew.services.integrations.base import BaseMusicService, MusicTrack, MusicPlaylist
from butler_crew.services.integrations.oauth import OAuthProvider


class SpotifyProvider(BaseMusicService, OAuthProvider):
    """Spotify API implementation."""

    def __init__(self):
        # Initialize OAuthProvider
        OAuthProvider.__init__(
            self,
            provider_name="spotify",
            token_url="https://accounts.spotify.com/api/token"
        )
        self.base_url = "https://api.spotify.com/v1"

    def _get_refresh_params(self, refresh_token: str) -> Dict[str, str]:
        """Parameters for Spotify token refresh."""
        return {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": os.getenv("SPOTIFY_CLIENT_ID", ""),
            "client_secret": os.getenv("SPOTIFY_CLIENT_SECRET", ""),
        }
    
    # Override request to support 204/202 status codes seamlessly
    async def authenticate(self) -> bool:
        return self.is_authenticated()

    async def get_current_playback(self) -> Optional[MusicTrack]:
        """Get currently playing track."""
        if not self.is_authenticated():
            return None
            
        try:
            response = await self.request("GET", f"{self.base_url}/me/player/currently-playing")
            if response.status_code == 204:
                return None
            response.raise_for_status()
            data = response.json()
            
            item = data.get("item")
            if not item:
                return None
                
            return MusicTrack(
                id=item["id"],
                name=item["name"],
                artist=", ".join(a["name"] for a in item["artists"]),
                album=item["album"]["name"],
                duration_ms=item["duration_ms"],
                is_playing=data.get("is_playing", False),
                uri=item["uri"]
            )
        except Exception as e:
            print(f"[Spotify] Error getting playback: {e}")
            return None

    async def play(self, context_uri: Optional[str] = None) -> bool:
        """Resume playback or play specific item."""
        if not self.is_authenticated():
            return False
            
        json_data = {}
        if context_uri:
            json_data["context_uri"] = context_uri
            
        try:
            response = await self.request("PUT", f"{self.base_url}/me/player/play", json=json_data if json_data else None)
            return response.status_code in (204, 202)
        except Exception:
            return False

    async def pause(self) -> bool:
        """Pause playback."""
        if not self.is_authenticated():
            return False
        try:
            response = await self.request("PUT", f"{self.base_url}/me/player/pause")
            return response.status_code in (204, 202)
        except Exception:
            return False

    async def next_track(self) -> bool:
        """Skip to next track."""
        if not self.is_authenticated():
            return False
        try:
            response = await self.request("POST", f"{self.base_url}/me/player/next")
            return response.status_code in (204, 202)
        except Exception:
            return False

    async def previous_track(self) -> bool:
        """Skip to previous track."""
        if not self.is_authenticated():
            return False
        try:
            response = await self.request("POST", f"{self.base_url}/me/player/previous")
            return response.status_code in (204, 202)
        except Exception:
            return False

    async def set_volume(self, volume_percent: int) -> bool:
        """Set volume (0-100)."""
        if not self.is_authenticated():
            return False
        try:
            response = await self.request(
                "PUT", 
                f"{self.base_url}/me/player/volume", 
                params={"volume_percent": volume_percent}
            )
            return response.status_code in (204, 202)
        except Exception:
            return False

    async def search(self, query: str, type: str = "track") -> List[dict]:
        """Search Spotify."""
        if not self.is_authenticated():
            return []
        try:
            response = await self.request(
                "GET", 
                f"{self.base_url}/search", 
                params={"q": query, "type": type, "limit": 5}
            )
            response.raise_for_status()
            data = response.json()
            return data.get(f"{type}s", {}).get("items", [])
        except Exception:
            return []

    async def get_playlists(self) -> List[MusicPlaylist]:
        """Get user's playlists."""
        if not self.is_authenticated():
            return []
            
        try:
            response = await self.request("GET", f"{self.base_url}/me/playlists", params={"limit": 20})
            response.raise_for_status()
            data = response.json()
            
            return [
                MusicPlaylist(
                    id=item["id"],
                    name=item["name"],
                    description=item.get("description"),
                    uri=item["uri"]
                )
                for item in data.get("items", [])
            ]
        except Exception:
            return []
