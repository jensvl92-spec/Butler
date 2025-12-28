"""CrewAI tools for alarm management."""

import json
from datetime import datetime
from typing import Optional, List
from crewai.tools import tool


@tool("set_alarm")
def set_alarm(
    time: str,
    label: Optional[str] = None,
    days: Optional[List[int]] = None,
) -> str:
    """
    Set an alarm on the user's device.
    
    Args:
        time: Time in HH:MM format (24-hour), e.g., "07:30" for 7:30 AM
        label: Optional label/message for the alarm (e.g., "Wake up", "Workout")
        days: Optional list of days for recurring alarms (0=Sunday, 1=Monday, etc.)
    
    Returns:
        JSON action for the frontend to execute via Android Intent
    
    Examples:
        - set_alarm(time="07:00") -> "Set alarm for 7:00 AM"
        - set_alarm(time="18:30", label="Dinner") -> "Set alarm for 6:30 PM labeled 'Dinner'"
        - set_alarm(time="06:00", days=[1,2,3,4,5]) -> "Set weekday alarm for 6:00 AM"
    """
    try:
        # Parse and validate time format
        time_parts = time.split(":")
        if len(time_parts) != 2:
            return json.dumps({
                "action": "set_alarm",
                "status": "error",
                "message": f"Invalid time format '{time}'. Use HH:MM (e.g., '07:30').",
            })
        
        hour = int(time_parts[0])
        minute = int(time_parts[1])
        
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            return json.dumps({
                "action": "set_alarm",
                "status": "error",
                "message": f"Invalid time '{time}'. Hour must be 0-23, minute must be 0-59.",
            })
        
        # Build action data for frontend
        action_data = {
            "type": "set_alarm",
            "data": {
                "hour": hour,
                "minute": minute,
                "message": label or "Alarm",
            }
        }
        
        # Add recurring days if specified
        if days is not None:
            action_data["data"]["days"] = days
        
        # Format human-readable time
        period = "AM" if hour < 12 else "PM"
        display_hour = hour if hour <= 12 else hour - 12
        if display_hour == 0:
            display_hour = 12
        time_str = f"{display_hour}:{minute:02d} {period}"
        
        # Build confirmation message
        if days:
            day_names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            day_str = ", ".join([day_names[d] for d in sorted(days)])
            message = f"Setting recurring alarm for {time_str} on {day_str}"
        else:
            message = f"Setting alarm for {time_str}"
        
        if label:
            message += f" ({label})"
        
        return json.dumps({
            "action": "set_alarm",
            "status": "success",
            "message": message,
            "action_data": action_data,
        })
        
    except ValueError as e:
        return json.dumps({
            "action": "set_alarm",
            "status": "error",
            "message": f"Invalid time value: {str(e)}",
        })
    except Exception as e:
        return json.dumps({
            "action": "set_alarm",
            "status": "error",
            "message": f"Failed to set alarm: {str(e)}",
        })
