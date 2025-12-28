from pydantic import BaseModel
from typing import Optional, List

class CommandRequest(BaseModel):
    """Request model for processing commands."""
    user_message: str
    connection_id: str
    language: str = "en"
    devices: Optional[list] = None
    services: Optional[dict] = None
    rooms: Optional[list] = None
    client_timestamp: Optional[str] = None

class CommandResponse(BaseModel):
    """Response model for processed commands."""
    text: str
    actions: list = []
    memory_saved: bool = False
    is_valid: bool = True
    rejection_message: Optional[str] = None
    logs: list[str] = []
