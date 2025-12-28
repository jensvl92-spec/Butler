"""Google OAuth Client."""

import os
from typing import Dict, Optional
from butler_crew.services.integrations.oauth import OAuthProvider

class GoogleClient(OAuthProvider):
    """Google OAuth client shared by Calendar and Gmail."""
    
    def __init__(self):
        super().__init__(
            provider_name="google",
            token_url="https://oauth2.googleapis.com/token"
        )
        
    def _get_refresh_params(self, refresh_token: str) -> Dict[str, str]:
        return {
            "client_id": os.getenv("GOOGLE_CLIENT_ID", ""),
            "client_secret": os.getenv("GOOGLE_CLIENT_SECRET", ""),
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }


# Singleton
_client: Optional[GoogleClient] = None

def get_google_client() -> GoogleClient:
    global _client
    if _client is None:
        _client = GoogleClient()
    return _client
