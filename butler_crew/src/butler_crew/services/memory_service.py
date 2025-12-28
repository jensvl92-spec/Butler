"""Memory service using ChromaDB for vector storage."""

import os
from typing import Any, Dict, List, Optional

try:
    import chromadb
    from chromadb.config import Settings
    CHROMA_AVAILABLE = True
except ImportError:
    CHROMA_AVAILABLE = False


class MemoryService:
    """
    User memory storage using ChromaDB.
    
    Stores preferences, clarifications, and other user memories
    with semantic search capability.
    """
    
    def __init__(self, persist_directory: Optional[str] = None):
        """
        Initialize the memory service.
        
        Args:
            persist_directory: Directory for ChromaDB persistence
        """
        self.persist_directory = persist_directory or "./data/chroma"
        self._client = None
        self._preferences_collection = None
        self._clarifications_collection = None
    
    @property
    def client(self):
        """Lazy-load ChromaDB client."""
        if self._client is None:
            if not CHROMA_AVAILABLE:
                raise ImportError("chromadb is not installed")
            
            os.makedirs(self.persist_directory, exist_ok=True)
            self._client = chromadb.PersistentClient(
                path=self.persist_directory,
                settings=Settings(anonymized_telemetry=False),
            )
        return self._client
    
    @property
    def preferences(self):
        """Get or create preferences collection."""
        if self._preferences_collection is None:
            self._preferences_collection = self.client.get_or_create_collection(
                name="user_preferences",
                metadata={"description": "User preferences and settings"},
            )
        return self._preferences_collection
    
    @property
    def clarifications(self):
        """Get or create clarifications collection."""
        if self._clarifications_collection is None:
            self._clarifications_collection = self.client.get_or_create_collection(
                name="name_clarifications",
                metadata={"description": "User term to entity ID mappings"},
            )
        return self._clarifications_collection
    
    # ---------- PREFERENCES ----------
    
    def save_preference(
        self,
        connection_id: str,
        category: str,
        key: str,
        value: Any,
        confirmed: bool = False,
    ) -> str:
        """Save a user preference."""
        import json
        
        doc_id = f"{connection_id}:{category}:{key}"
        document = f"{category} {key}: {json.dumps(value)}"
        
        self.preferences.upsert(
            ids=[doc_id],
            documents=[document],
            metadatas=[{
                "connection_id": connection_id,
                "category": category,
                "key": key,
                "value": json.dumps(value),
                "confirmed": confirmed,
            }],
        )
        return doc_id
    
    def get_preferences(
        self,
        connection_id: str,
        category: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Get user preferences, optionally filtered by category."""
        where_filter = {"connection_id": connection_id}
        if category:
            where_filter["category"] = category
        
        results = self.preferences.get(
            where=where_filter,
            include=["metadatas"],
        )
        
        import json
        return [
            {
                "category": m["category"],
                "key": m["key"],
                "value": json.loads(m["value"]),
                "confirmed": m.get("confirmed", False),
            }
            for m in (results.get("metadatas") or [])
        ]
    
    def search_preferences(
        self,
        connection_id: str,
        query: str,
        limit: int = 5,
    ) -> List[Dict[str, Any]]:
        """Semantic search for relevant preferences."""
        results = self.preferences.query(
            query_texts=[query],
            where={"connection_id": connection_id},
            n_results=limit,
            include=["metadatas", "distances"],
        )
        
        import json
        prefs = []
        for i, m in enumerate(results.get("metadatas", [[]])[0]):
            prefs.append({
                "category": m["category"],
                "key": m["key"],
                "value": json.loads(m["value"]),
                "distance": results.get("distances", [[]])[0][i] if results.get("distances") else None,
            })
        return prefs
    
    # ---------- CLARIFICATIONS ----------
    
    def save_clarification(
        self,
        connection_id: str,
        user_term: str,
        entity_ids: List[str],
        context: Optional[str] = None,
    ) -> str:
        """Save a name clarification (user term -> entity IDs)."""
        import json
        
        doc_id = f"{connection_id}:{user_term.lower()}"
        document = f"When user says '{user_term}', they mean: {', '.join(entity_ids)}"
        if context:
            document += f" (Context: {context})"
        
        self.clarifications.upsert(
            ids=[doc_id],
            documents=[document],
            metadatas=[{
                "connection_id": connection_id,
                "user_term": user_term.lower(),
                "entity_ids": json.dumps(entity_ids),
                "context": context or "",
            }],
        )
        return doc_id
    
    def lookup_clarification(
        self,
        connection_id: str,
        user_term: str,
    ) -> Optional[List[str]]:
        """Look up exact match for a user term."""
        results = self.clarifications.get(
            ids=[f"{connection_id}:{user_term.lower()}"],
            include=["metadatas"],
        )
        
        if results.get("metadatas"):
            import json
            return json.loads(results["metadatas"][0]["entity_ids"])
        return None
    
    def search_clarifications(
        self,
        connection_id: str,
        query: str,
        limit: int = 3,
    ) -> List[Dict[str, Any]]:
        """Semantic search for clarifications."""
        results = self.clarifications.query(
            query_texts=[query],
            where={"connection_id": connection_id},
            n_results=limit,
            include=["metadatas", "distances"],
        )
        
        import json
        clarifications = []
        for i, m in enumerate(results.get("metadatas", [[]])[0]):
            clarifications.append({
                "user_term": m["user_term"],
                "entity_ids": json.loads(m["entity_ids"]),
                "context": m.get("context"),
                "distance": results.get("distances", [[]])[0][i] if results.get("distances") else None,
            })
        return clarifications

# Singleton Instance
_memory_service_instance = None

def get_memory_service() -> MemoryService:
    """Get the singleton MemoryService instance."""
    global _memory_service_instance
    if _memory_service_instance is None:
        # data/memory is a good persistent path for HA Add-ons
        # Ensure the directory exists
        persist_dir = os.getenv("MEMORY_PATH", "/share/butler_memory")
        # Check if we are running locally (no /share)
        if not os.path.exists("/share"):
             # Fallback to local ./data
            persist_dir = "./data/chroma"
            
        print(f"[Memory] Initializing ChromaDB at {persist_dir}")
        _memory_service_instance = MemoryService(persist_directory=persist_dir)
    return _memory_service_instance
