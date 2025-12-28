"""Gmail provider."""

from typing import List, Optional
from butler_crew.services.integrations.base import BaseEmailService, EmailMessage
from butler_crew.services.integrations.google import get_google_client


class GmailProvider(BaseEmailService):
    """Gmail API implementation using shared Google client."""

    def __init__(self):
        self.client = get_google_client()

    async def get_recent_emails(self, limit: int = 5) -> List[EmailMessage]:
        """Get recent unread emails."""
        if not self.client.is_authenticated():
            return []
            
        try:
            # 1. List messages (ids only)
            response = await self.client.request(
                "GET",
                "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                params={"maxResults": limit, "q": "is:unread category:primary"}
            )
            response.raise_for_status()
            messages = response.json().get("messages", [])
            
            results = []
            for msg in messages:
                detail = await self._get_message_detail(msg["id"])
                if detail:
                    results.append(detail)
            return results
            
        except Exception as e:
            print(f"[Gmail] Error getting emails: {e}")
            return []

    async def _get_message_detail(self, msg_id: str) -> Optional[EmailMessage]:
        """Helper to get full message details."""
        try:
            response = await self.client.request(
                "GET",
                f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}"
            )
            if response.status_code != 200:
                return None
                
            data = response.json()
            payload = data.get("payload", {})
            headers = payload.get("headers", [])
            
            subject = next((h["value"] for h in headers if h["name"] == "Subject"), "No Subject")
            sender = next((h["value"] for h in headers if h["name"] == "From"), "Unknown")
            
            snippet = data.get("snippet", "")
            
            return EmailMessage(
                id=data["id"],
                sender=sender,
                subject=subject,
                snippet=snippet,
                is_read="UNREAD" not in data.get("labelIds", []),
                received_at=data.get("internalDate") # Timestamp ms
            )
        except Exception:
            return None

    async def search_emails(self, query: str, limit: int = 5) -> List[EmailMessage]:
        """Search emails."""
        if not self.client.is_authenticated():
            return []
            
        try:
            response = await self.client.request(
                "GET",
                "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                params={"maxResults": limit, "q": query}
            )
            messages = response.json().get("messages", [])
            
            results = []
            for msg in messages:
                detail = await self._get_message_detail(msg["id"])
                if detail:
                    results.append(detail)
            return results
        except Exception:
            return []

    async def send_email(self, to: str, subject: str, body: str) -> bool:
        """Send an email."""
        print(f"[Gmail] Mock sending email to {to}")
        return True # Mock success for now

    async def reply_to_email(self, email_id: str, body: str) -> bool:
        print(f"[Gmail] Mock reply to {email_id}")
        return True

    async def mark_as_read(self, email_id: str) -> bool:
        """Mark email as read."""
        if not self.client.is_authenticated():
            return False
        try:
            await self.client.request(
                "POST",
                f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{email_id}/batchModify",
                json={"removeLabelIds": ["UNREAD"]}
            )
            return True
        except Exception:
            return False
