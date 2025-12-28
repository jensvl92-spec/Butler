"""Supabase client for Butler Crew."""

import os
from supabase import create_client, Client
from typing import Optional, Dict, Any


class SupabaseDB:
    """Singleton wrapper for Supabase client."""
    
    _instance: Optional['SupabaseDB'] = None
    _client: Optional[Client] = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(SupabaseDB, cls).__new__(cls)
        return cls._instance
    
    def __init__(self):
        if self._client is None:
            url = os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL")
            key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")
            
            if url and key:
                try:
                    self._client = create_client(url, key)
                except Exception as e:
                    print(f"[Supabase] Init Error: {e}")
            else:
                print("[WARNING] Supabase credentials not found. DB features will be disabled.")
    
    @property
    def client(self) -> Optional[Client]:
        """Get the raw Supabase client."""
        return self._client
    
    def get_token(self, user_id: str, provider: str) -> Optional[Dict[str, Any]]:
        """Retrieve an OAuth token for a user/provider."""
        if not self._client:
            return None
            
        try:
            response = self._client.table("user_integrations") \
                .select("*") \
                .eq("user_id", user_id) \
                .eq("provider", provider) \
                .execute()
                
            if response.data and len(response.data) > 0:
                return response.data[0]
            return None
        except Exception as e:
            print(f"[Supabase] Error fetching token: {e}")
            return None
    
    def save_token(self, user_id: str, provider: str, token_data: Dict[str, Any]) -> bool:
        """Save or update an OAuth token."""
        if not self._client:
            return False
            
        data = {
            "user_id": user_id,
            "provider": provider,
            "access_token": token_data.get("access_token"),
            "refresh_token": token_data.get("refresh_token"),
            "expires_at": token_data.get("expires_at"),
            "token_type": token_data.get("token_type"),
            "scope": token_data.get("scope"),
            "updated_at": "now()",
        }
        
        try:
            # Check if exists
            existing = self.get_token(user_id, provider)
            if existing:
                self._client.table("user_integrations") \
                    .update(data) \
                    .eq("id", existing["id"]) \
                    .execute()
            else:
                self._client.table("user_integrations") \
                    .insert(data) \
                    .execute()
            return True
        except Exception as e:
            print(f"[Supabase] Error saving token: {e}")
            return False


def get_db() -> SupabaseDB:
    """Get DB instance."""
    return SupabaseDB()
