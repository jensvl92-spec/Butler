
import asyncio
import json
import logging
import os
import websockets
from typing import Optional, Callable
from butler_crew.schemas import CommandRequest, CommandResponse
from butler_crew.services.command_processor import process_command_logic

# Use internal Supervisor URL for Add-ons
HA_WS_URL = "http://supervisor/core/websocket" # Wait, websockets need ws://
# Supervisor API usually works via http for REST, but for WS it might be ws://supervisor/core/websocket
# Correction: The Supervisor allows add-ons to connect to HA Core.
# The URL "ws://supervisor/core/websocket" is correct for internal communication within the docker network.

logger = logging.getLogger(__name__)

class HAEventListener:
    """
    Listens to Home Assistant events via WebSocket.
    Specifically listens for 'butler_service_request' and fires 'butler_service_response'.
    """
    def __init__(self):
        self.token = os.getenv("SUPERVISOR_TOKEN")
        self.running = False
        self.ws = None
        self._message_id = 1
        
    async def start(self):
        """Start the listener loop."""
        if not self.token:
            logger.error("SUPERVISOR_TOKEN not found. Cannot start HA Event Listener.")
            return

        self.running = True
        logger.info(f"Starting HA Event Listener...")
        
        while self.running:
            try:
                # Connect to HA WebSocket
                # Note: headers are not standard for WS auth in HA, usually it's the first message.
                async with websockets.connect(
                    "ws://supervisor/core/websocket",
                    extra_headers={"Authorization": f"Bearer {self.token}"} 
                    # Wait, Supervisor might require header auth or message auth. 
                    # Standard HA WS API uses message auth. Supervisor proxy might be different.
                    # Let's try standard auth flow first if header fails, but Supervisor usually accepts header?
                    # Actually, standard HA WS requires sending {"type": "auth", "access_token": ...}
                ) as websocket:
                    self.ws = websocket
                    logger.info("Connected to HA WebSocket via Supervisor.")
                    
                    # Authenticate (Standard Flow)
                    # Even if header is passed, HA might expect Auth phase.
                    # But Supervisor Proxy often handles auth. Let's handle the initial handshake.
                    
                    # HA sends initial message
                    init_msg = await websocket.recv()
                    init_data = json.loads(init_msg)
                    
                    if init_data.get("type") == "auth_required":
                        logger.info("Auth required, sending token...")
                        await websocket.send(json.dumps({
                            "type": "auth",
                            "access_token": self.token
                        }))
                        
                        auth_response = await websocket.recv()
                        auth_data = json.loads(auth_response)
                        
                        if auth_data.get("type") != "auth_ok":
                            logger.error(f"Auth failed: {auth_data}")
                            break # Retry loop
                        logger.info("Auth OK!")

                    # Subscribe to Events
                    await self._subscribe(websocket)

                    # Event Loop
                    async for message in websocket:
                        data = json.loads(message)
                        if data.get("type") == "event":
                            event_data = data.get("event", {})
                            # Verify it's our event (though we filtered in subscribe)
                            # Actually subscribe_events doesn't filter perfectly server side in old versions,
                            # but usually we subscribe to "state_changed" or "fire_event".
                            # Usage: {"type": "subscribe_events", "event_type": "butler_service_request"}
                            
                            if event_data.get("event_type") == "butler_service_request":
                                # Spawn task to process
                                asyncio.create_task(self._handle_request(event_data.get("data", {})))
                        
            except Exception as e:
                logger.error(f"WebSocket Error: {e}. Reconnecting in 5s...")
                await asyncio.sleep(5)
    
    async def stop(self):
        self.running = False
        if self.ws:
            await self.ws.close()
            
    async def _subscribe(self, ws):
        self._message_id += 1
        msg = {
            "id": self._message_id,
            "type": "subscribe_events",
            "event_type": "butler_service_request"
        }
        await ws.send(json.dumps(msg))
        logger.info("Subscribed to 'butler_service_request'")

    async def _handle_request(self, data: dict):
        """Process the incoming event request."""
        connection_id = data.get("connection_id")
        if not connection_id:
            logger.warning("Received request without connection_id. Ignoring.")
            return

        logger.info(f"Received Event Request from {connection_id}")
        
        # Map dict to CommandRequest
        try:
            request = CommandRequest(
                user_message=data.get("user_message", ""),
                connection_id=connection_id,
                language=data.get("language", "en"),
                devices=data.get("devices", []),
                services=data.get("services", {}),
                rooms=data.get("rooms", []),
                client_timestamp=data.get("client_timestamp")
            )
            
            # PROCESS (CPU Bound or IO Bound - Run in thread or async?)
            # process_command_logic creates logs and runs crew. kickoff might be blocking or async?
            # CrewAI kickoff is usually sync. We should run in executor if possible to not block WS loop.
            # But process_command_logic is sync.
            
            response: CommandResponse = await asyncio.to_thread(process_command_logic, request)
            
            # Send Response Event
            await self._fire_response(connection_id, response)
            
        except Exception as e:
            logger.error(f"Error handling request: {e}")
            # Try to send error response
            err_resp = CommandResponse(text=f"Server Error: {str(e)}", is_valid=False)
            await self._fire_response(connection_id, err_resp)

    async def _fire_response(self, connection_id: str, response: CommandResponse):
        """Fire an event back to HA."""
        if not self.ws: return
        
        # We use 'call_service' to fire an event? Or is there a fire_event command?
        # Typically we use 'fire_event' service in HA or the WS command 'fire_event'.
        # WS Command: {"type": "fire_event", "event_type": "...", "event_data": ...}
        
        self._message_id += 1
        msg = {
            "id": self._message_id,
            "type": "fire_event",
            "event_type": "butler_service_response",
            "event_data": {
                "connection_id": connection_id,
                "response": response.model_dump()
            }
        }
        await self.ws.send(json.dumps(msg))
        logger.info(f"Fired Response Event to {connection_id}")
