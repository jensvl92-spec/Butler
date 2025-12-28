"""Context management for Butler Crew."""

from contextvars import ContextVar
from typing import Optional

# Context variable to store the current user/connection ID
_user_id_ctx: ContextVar[Optional[str]] = ContextVar("user_id", default=None)


def get_current_user_id() -> Optional[str]:
    """Get the current user ID (connection ID) from context."""
    return _user_id_ctx.get()


def set_current_user_id(user_id: str):
    """Set the current user ID in context."""
    return _user_id_ctx.set(user_id)


def reset_current_user_id(token):
    """Reset the user ID context."""
    _user_id_ctx.reset(token)
