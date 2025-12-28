"""Base OAuth Provider."""

import os
from abc import ABC, abstractmethod
from typing import Optional, Dict, Any, Union
from datetime import datetime, timedelta

import httpx
from butler_crew.services.db import get_db
from butler_crew.context import get_current_user_id


class OAuthProvider(ABC):
    """Base class for OAuth providers handling token refresh."""
    
    def __init__(self, provider_name: str, token_url: str):
        self.provider_name = provider_name
        self.token_url = token_url
    
    def get_token(self) -> Optional[Dict[str, Any]]:
        """Get current access token for context user."""
        user_id = get_current_user_id()
        if not user_id:
            print(f"[{self.provider_name}] No user context found.")
            return None
            
        db = get_db()
        return db.get_token(user_id, self.provider_name)
    
    def is_authenticated(self) -> bool:
        """Check if we have a token."""
        return self.get_token() is not None
    
    async def get_valid_token(self) -> Optional[str]:
        """Get a valid access token, refreshing if needed."""
        token_data = self.get_token()
        if not token_data:
            return None
            
        expires_at_str = token_data.get("expires_at")
        refresh_token = token_data.get("refresh_token")
        
        if not expires_at_str or not refresh_token:
            # Can't refresh
            return token_data.get("access_token")
        
        # Check expiry
        try:
            # Handles fractional seconds if present
            if expires_at_str.endswith("Z"):
                expires_at_str = expires_at_str[:-1]
            expires_at = datetime.fromisoformat(expires_at_str)
            
            # Refresh if expiring in < 5 mins
            if datetime.utcnow() > (expires_at - timedelta(minutes=5)):
                print(f"[{self.provider_name}] Token expiring, refreshing...")
                return await self._refresh_token(refresh_token)
        except Exception as e:
            print(f"[{self.provider_name}] Date parse error: {e}")
            
        return token_data.get("access_token")
        
    async def _refresh_token(self, refresh_token: str) -> Optional[str]:
        """Refresh the access token."""
        user_id = get_current_user_id()
        if not user_id:
            return None
            
        params = self._get_refresh_params(refresh_token)
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(self.token_url, data=params)
                response.raise_for_status()
                new_data = response.json()
                
                # Merge with existing data (keep refresh token if not returned)
                current_token = self.get_token() or {}
                
                # Update expiry
                expires_in = new_data.get("expires_in", 3600)
                new_data["expires_at"] = (datetime.utcnow() + timedelta(seconds=expires_in)).isoformat()
                
                # Update DB
                updated_token = {**current_token, **new_data}
                get_db().save_token(user_id, self.provider_name, updated_token)
                
                return new_data.get("access_token")
        except Exception as e:
            print(f"[{self.provider_name}] Refresh failed: {e}")
            return None

    @abstractmethod
    def _get_refresh_params(self, refresh_token: str) -> Dict[str, str]:
        """Return parameters for refresh request."""
        pass
    
    async def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        """Make an authenticated request with retry logic."""
        token = await self.get_valid_token()
        if not token:
            raise ValueError(f"Not authenticated with {self.provider_name}")
            
        headers = kwargs.get("headers", {})
        headers["Authorization"] = f"Bearer {token}"
        kwargs["headers"] = headers
        
        async with httpx.AsyncClient() as client:
            response = await client.request(method, url, **kwargs)
            
            # If 401, try one refresh force
            if response.status_code == 401:
                print(f"[{self.provider_name}] 401 received, forcing refresh...")
                token_data = self.get_token()
                if token_data and token_data.get("refresh_token"):
                    new_token = await self._refresh_token(token_data["refresh_token"])
                    if new_token:
                        # Retry
                        headers["Authorization"] = f"Bearer {new_token}"
                        response = await client.request(method, url, **kwargs)
                        
            return response
