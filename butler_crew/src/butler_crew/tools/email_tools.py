"""CrewAI tools for email operations."""

import json
from crewai.tools import tool


@tool("get_recent_emails")
def get_recent_emails(count: int = 10, unread_only: bool = False) -> str:
    """
    Get recent emails from the user's inbox.
    
    Args:
        count: Number of emails to retrieve (default: 10)
        unread_only: If True, only get unread emails
    
    Returns:
        JSON list of emails with subject, sender, date, preview
    """
    return json.dumps({
        "action": "get_recent_emails",
        "count": count,
        "unread_only": unread_only,
        "status": "provider_not_connected",
        "message": "Email provider not connected. User needs to connect their email in settings.",
        "emails": [],
    })


@tool("search_emails")
def search_emails(query: str, count: int = 10) -> str:
    """
    Search for emails matching a query.
    
    Args:
        query: Search query (e.g., "from:john@example.com", "subject:meeting")
        count: Maximum number of results
    
    Returns:
        JSON list of matching emails
    """
    return json.dumps({
        "action": "search_emails",
        "query": query,
        "count": count,
        "status": "provider_not_connected",
        "emails": [],
    })


@tool("send_email")
def send_email(
    to: str,
    subject: str,
    body: str,
    cc: str = "",
) -> str:
    """
    Send an email.
    
    Args:
        to: Recipient email address (comma-separated for multiple)
        subject: Email subject line
        body: Email body content
        cc: Optional CC recipients (comma-separated)
    
    Returns:
        JSON confirmation of email sent or error
    """
    recipients = [r.strip() for r in to.split(",")]
    cc_list = [c.strip() for c in cc.split(",")] if cc else []
    
    return json.dumps({
        "action": "send_email",
        "to": recipients,
        "cc": cc_list,
        "subject": subject,
        "body_preview": body[:100] + "..." if len(body) > 100 else body,
        "status": "provider_not_connected",
        "message": "Email would be sent once provider is connected.",
    })


@tool("reply_to_email")
def reply_to_email(email_id: str, body: str) -> str:
    """
    Reply to an existing email thread.
    
    Args:
        email_id: ID of the email to reply to
        body: Reply message content
    
    Returns:
        JSON confirmation of reply sent
    """
    return json.dumps({
        "action": "reply_to_email",
        "email_id": email_id,
        "body_preview": body[:100] + "..." if len(body) > 100 else body,
        "status": "provider_not_connected",
    })


@tool("summarize_unread_emails")
def summarize_unread_emails() -> str:
    """
    Get a summary of unread emails.
    
    Returns:
        JSON with count and brief summary of unread emails
    """
    return json.dumps({
        "action": "summarize_unread_emails",
        "status": "provider_not_connected",
        "unread_count": 0,
        "summary": "Connect your email in settings to see unread messages.",
    })
