"""Base classes for external service integrations."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional


class ProviderType(Enum):
    """Supported integration providers."""
    # Calendar
    GOOGLE_CALENDAR = "google_calendar"
    OUTLOOK_CALENDAR = "outlook_calendar"
    
    # Email
    GMAIL = "gmail"
    OUTLOOK_EMAIL = "outlook_email"
    IMAP_SMTP = "imap_smtp"
    
    # Navigation
    GOOGLE_MAPS = "google_maps"


@dataclass
class CalendarEvent:
    """Standardized calendar event across providers."""
    id: str
    title: str
    start: datetime
    end: datetime
    location: Optional[str] = None
    description: Optional[str] = None
    attendees: Optional[List[str]] = None
    is_all_day: bool = False
    provider: Optional[ProviderType] = None
    raw_data: Optional[Dict[str, Any]] = None


@dataclass
class Email:
    """Standardized email across providers."""
    id: str
    subject: str
    sender: str
    recipients: List[str]
    body: str
    received_at: datetime
    is_read: bool = False
    is_important: bool = False
    thread_id: Optional[str] = None
    attachments: Optional[List[str]] = None
    provider: Optional[ProviderType] = None
    raw_data: Optional[Dict[str, Any]] = None


@dataclass
class DirectionsResult:
    """Standardized navigation result."""
    origin: str
    destination: str
    distance_meters: int
    duration_seconds: int
    duration_in_traffic_seconds: Optional[int] = None
    summary: str = ""
    steps: Optional[List[str]] = None
    provider: Optional[ProviderType] = None


class BaseCalendarService(ABC):
    """Abstract base class for calendar integrations."""
    
    provider: ProviderType
    
    @abstractmethod
    async def authenticate(self, credentials: Dict[str, Any]) -> bool:
        """Authenticate with the calendar provider."""
        pass
    
    @abstractmethod
    async def get_events(
        self,
        start: datetime,
        end: datetime,
        calendar_id: Optional[str] = None,
    ) -> List[CalendarEvent]:
        """Get events within a date range."""
        pass
    
    @abstractmethod
    async def create_event(
        self,
        title: str,
        start: datetime,
        end: datetime,
        location: Optional[str] = None,
        description: Optional[str] = None,
        attendees: Optional[List[str]] = None,
        calendar_id: Optional[str] = None,
    ) -> CalendarEvent:
        """Create a new calendar event."""
        pass
    
    @abstractmethod
    async def update_event(
        self,
        event_id: str,
        updates: Dict[str, Any],
        calendar_id: Optional[str] = None,
    ) -> CalendarEvent:
        """Update an existing event."""
        pass
    
    @abstractmethod
    async def delete_event(
        self,
        event_id: str,
        calendar_id: Optional[str] = None,
    ) -> bool:
        """Delete an event."""
        pass
    
    @abstractmethod
    async def list_calendars(self) -> List[Dict[str, str]]:
        """List available calendars."""
        pass


class BaseEmailService(ABC):
    """Abstract base class for email integrations."""
    
    provider: ProviderType
    
    @abstractmethod
    async def authenticate(self, credentials: Dict[str, Any]) -> bool:
        """Authenticate with the email provider."""
        pass
    
    @abstractmethod
    async def get_emails(
        self,
        count: int = 10,
        folder: str = "inbox",
        unread_only: bool = False,
    ) -> List[Email]:
        """Get recent emails."""
        pass
    
    @abstractmethod
    async def search_emails(
        self,
        query: str,
        count: int = 10,
    ) -> List[Email]:
        """Search emails by query."""
        pass
    
    @abstractmethod
    async def send_email(
        self,
        to: List[str],
        subject: str,
        body: str,
        cc: Optional[List[str]] = None,
        bcc: Optional[List[str]] = None,
    ) -> bool:
        """Send an email."""
        pass
    
    @abstractmethod
    async def reply_to_email(
        self,
        email_id: str,
        body: str,
    ) -> bool:
        """Reply to an email."""
        pass
    
    @abstractmethod
    async def mark_as_read(self, email_id: str) -> bool:
        """Mark an email as read."""
        pass


class BaseNavigationService(ABC):
    """Abstract base class for navigation integrations."""
    
    provider: ProviderType
    
    @abstractmethod
    async def authenticate(self, credentials: Dict[str, Any]) -> bool:
        """Authenticate with the navigation provider (usually just API key)."""
        pass
    
    @abstractmethod
    async def get_directions(
        self,
        origin: str,
        destination: str,
        mode: str = "driving",  # driving, walking, transit, bicycling
        departure_time: Optional[datetime] = None,
    ) -> DirectionsResult:
        """Get directions between two points."""
        pass
    
    @abstractmethod
    async def get_eta(
        self,
        origin: str,
        destination: str,
        mode: str = "driving",
    ) -> int:
        """Get estimated time of arrival in seconds."""
        pass
    
    @abstractmethod
    async def get_distance(
        self,
        origin: str,
        destination: str,
    ) -> int:
        """Get distance in meters."""
        pass
