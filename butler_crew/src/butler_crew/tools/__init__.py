"""Tools package for Butler Crew."""

from butler_crew.tools.ha_tools import (
    call_ha_service,
    get_device_states,
    get_device_history,
    create_automation,
    delete_automation,
)
from butler_crew.tools.memory_tools import (
    get_user_preferences,
    save_user_preference,
    get_name_clarifications,
    save_name_clarification,
    check_denied_proposals,
    record_proposal_denial,
)
from butler_crew.tools.calendar_tools import (
    get_upcoming_events,
    create_calendar_event,
    delete_calendar_event,
    find_free_time,
    whats_my_next_meeting,
)
from butler_crew.tools.email_tools import (
    get_recent_emails,
    search_emails,
    send_email,
    reply_to_email,
    summarize_unread_emails,
)
from butler_crew.tools.navigation_tools import (
    get_directions,
    get_eta,
    get_commute_time,
    check_traffic,
)
from butler_crew.tools.weather_tools import (
    get_current_weather,
    get_weather_forecast,
    will_it_rain,
    do_i_need_umbrella,
)
from butler_crew.tools.music_tools import (
    whats_playing,
    play_music,
    pause_music,
    next_song,
    previous_song,
    set_music_volume,
    get_my_playlists,
)
from butler_crew.tools.task_tools import (
    get_my_tasks,
    add_task,
    complete_task,
    whats_on_my_todo,
    add_to_shopping_list,
    get_shopping_list,
)
from butler_crew.tools.alarm_tools import (
    set_alarm,
)


__all__ = [
    # HA Tools
    "call_ha_service",
    "get_device_states",
    "get_device_history",
    "create_automation",
    "delete_automation",
    # Memory Tools
    "get_user_preferences",
    "save_user_preference",
    "get_name_clarifications",
    "save_name_clarification",
    "check_denied_proposals",
    "record_proposal_denial",
    # Calendar Tools
    "get_upcoming_events",
    "create_calendar_event",
    "delete_calendar_event",
    "find_free_time",
    "whats_my_next_meeting",
    # Email Tools
    "get_recent_emails",
    "search_emails",
    "send_email",
    "reply_to_email",
    "summarize_unread_emails",
    # Navigation Tools
    "get_directions",
    "get_eta",
    "get_commute_time",
    "check_traffic",
    # Weather Tools
    "get_current_weather",
    "get_weather_forecast",
    "will_it_rain",
    "do_i_need_umbrella",
    # Music Tools
    "whats_playing",
    "play_music",
    "pause_music",
    "next_song",
    "previous_song",
    "set_music_volume",
    "get_my_playlists",
    # Task Tools
    "get_my_tasks",
    "add_task",
    "complete_task",
    "whats_on_my_todo",
    "add_to_shopping_list",
    "get_shopping_list",
    # Alarm Tools
    "set_alarm",
]



