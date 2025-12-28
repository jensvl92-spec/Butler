"""Google Calendar provider."""

from datetime import datetime
from typing import List, Optional

from butler_crew.services.integrations.base import BaseCalendarService, CalendarEvent
from butler_crew.services.integrations.google import get_google_client


class GoogleCalendarProvider(BaseCalendarService):
    """Google Calendar implementation using shared Google OAuth client."""

    def __init__(self):
        self.client = get_google_client()
        
    async def get_upcoming_events(self, limit: int = 5) -> List[CalendarEvent]:
        """Get upcoming events from primary calendar."""
        if not self.client.is_authenticated():
            print("[GoogleCalendar] Not authenticated")
            return []
            
        now = datetime.utcnow().isoformat() + "Z"  # 'Z' indicates UTC time
        
        try:
            response = await self.client.request(
                "GET",
                "https://www.googleapis.com/calendar/v3/calendars/primary/events",
                params={
                    "maxResults": limit,
                    "orderBy": "startTime",
                    "singleEvents": True,
                    "timeMin": now,
                }
            )
            response.raise_for_status()
            data = response.json()
            
            events = []
            for item in data.get("items", []):
                start = item.get("start", {}).get("dateTime") or item.get("start", {}).get("date")
                end = item.get("end", {}).get("dateTime") or item.get("end", {}).get("date")
                
                events.append(CalendarEvent(
                    id=item.get("id"),
                    summary=item.get("summary", "No Title"),
                    start_time=start,
                    end_time=end,
                    description=item.get("description"),
                    location=item.get("location"),
                    html_link=item.get("htmlLink"),
                ))
            return events
            
        except Exception as e:
            print(f"[GoogleCalendar] Error fetching events: {e}")
            return []

    async def create_event(
        self,
        summary: str,
        start_time: str,
        end_time: str,
        description: Optional[str] = None
    ) -> Optional[CalendarEvent]:
        """Create a new event."""
        if not self.client.is_authenticated():
            return None

        body = {
            "summary": summary,
            "start": {"dateTime": start_time},
            "end": {"dateTime": end_time},
            "description": description or "",
        }
        
        try:
            response = await self.client.request(
                "POST",
                "https://www.googleapis.com/calendar/v3/calendars/primary/events",
                json=body
            )
            response.raise_for_status()
            item = response.json()
            
            return CalendarEvent(
                id=item.get("id"),
                summary=item.get("summary"),
                start_time=item.get("start", {}).get("dateTime"),
                end_time=item.get("end", {}).get("dateTime"),
                description=item.get("description"),
                html_link=item.get("htmlLink"),
            )
        except Exception as e:
            print(f"[GoogleCalendar] Error creating event: {e}")
            return None

    async def delete_event(self, event_id: str) -> bool:
        """Delete an event."""
        if not self.client.is_authenticated():
            return False
            
        try:
            response = await self.client.request(
                "DELETE",
                f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{event_id}"
            )
            return response.status_code == 204
        except Exception as e:
            print(f"[GoogleCalendar] Error deleting event: {e}")
            return False

    async def list_calendars(self) -> List[dict]:
        """List available calendars."""
        return [{"id": "primary", "summary": "Primary"}]
