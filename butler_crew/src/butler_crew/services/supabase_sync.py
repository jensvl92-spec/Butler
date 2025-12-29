"""
Supabase Sync Service

Syncs Home Assistant device inventory to Supabase database.
This allows Supabase Edge Functions to query devices without
calling back to the local network.

FLOW:
1. Connect to Home Assistant via REST API
2. Fetch all entity states
3. Upload to Supabase device_inventory table
4. Repeat every 5 minutes
"""

import os
import json
import logging
import asyncio
from typing import Optional
import httpx

logger = logging.getLogger(__name__)

# Environment variables
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
HA_URL = os.getenv("HA_URL", "http://supervisor/core")
HA_TOKEN = os.getenv("SUPERVISOR_TOKEN")
CONNECTION_ID = os.getenv("CONNECTION_ID")

# Sync interval in seconds
SYNC_INTERVAL = 300  # 5 minutes


class SupabaseSync:
    """Syncs HA entities to Supabase."""
    
    def __init__(self):
        self.supabase_url = SUPABASE_URL
        self.supabase_key = SUPABASE_SERVICE_KEY
        self.ha_url = HA_URL
        self.ha_token = HA_TOKEN
        self.connection_id = CONNECTION_ID
        self._running = False
    
    async def fetch_ha_entities(self) -> list:
        """Fetch all entity states from Home Assistant."""
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.ha_url}/api/states",
                headers={"Authorization": f"Bearer {self.ha_token}"},
                timeout=30
            )
            response.raise_for_status()
            return response.json()
    
    async def sync_to_supabase(self, entities: list) -> dict:
        """Upload entities to Supabase via MCP proxy sync endpoint."""
        if not self.supabase_url or not self.supabase_key:
            logger.warning("Supabase not configured, skipping sync")
            return {"skipped": True}
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.supabase_url}/functions/v1/mcp-proxy/sync",
                headers={
                    "Authorization": f"Bearer {self.supabase_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "connection_id": self.connection_id,
                    "entities": entities
                },
                timeout=60
            )
            response.raise_for_status()
            return response.json()
    
    async def sync_once(self) -> dict:
        """Perform a single sync."""
        try:
            logger.info("Starting device sync...")
            
            # Fetch from HA
            entities = await self.fetch_ha_entities()
            logger.info(f"Fetched {len(entities)} entities from HA")
            
            # Filter to relevant domains
            relevant_domains = [
                'light', 'switch', 'climate', 'cover', 'fan',
                'media_player', 'sensor', 'binary_sensor', 'automation',
                'script', 'scene', 'input_boolean', 'input_select'
            ]
            
            filtered = [
                e for e in entities 
                if e.get('entity_id', '').split('.')[0] in relevant_domains
            ]
            logger.info(f"Filtered to {len(filtered)} relevant entities")
            
            # Sync to Supabase
            result = await self.sync_to_supabase(filtered)
            logger.info(f"Sync complete: {result}")
            
            return result
            
        except Exception as e:
            logger.error(f"Sync failed: {e}", exc_info=True)
            return {"error": str(e)}
    
    async def start_periodic_sync(self):
        """Start periodic sync loop."""
        self._running = True
        logger.info(f"Starting periodic sync (every {SYNC_INTERVAL}s)")
        
        while self._running:
            await self.sync_once()
            await asyncio.sleep(SYNC_INTERVAL)
    
    def stop(self):
        """Stop periodic sync."""
        self._running = False


# Singleton instance
_sync_service: Optional[SupabaseSync] = None


def get_sync_service() -> SupabaseSync:
    """Get or create the sync service singleton."""
    global _sync_service
    if _sync_service is None:
        _sync_service = SupabaseSync()
    return _sync_service


async def initial_sync():
    """Perform initial sync on startup."""
    service = get_sync_service()
    return await service.sync_once()


async def start_background_sync():
    """Start background sync task."""
    service = get_sync_service()
    asyncio.create_task(service.start_periodic_sync())
