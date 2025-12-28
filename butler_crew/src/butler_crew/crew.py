"""CrewAI Crew definition for Butler multi-agent system."""

from typing import Any, Dict, List

from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task
from crewai.agents.agent_builder.base_agent import BaseAgent

from butler_crew.tools.ha_tools import (
    call_ha_service,
    get_device_states,
)
from butler_crew.tools.memory_tools import (
    get_user_preferences,
    save_user_preference,
    check_denied_proposals,
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



@CrewBase
class ButlerCrew:
    """
    Butler Crew - Multi-agent Home Assistant control system.
    
    Agents work in a hierarchical process with the Butler as manager.
    The Bouncer validates first, then Butler orchestrates execution.
    """
    
    agents: List[BaseAgent]
    tasks: List[Task]
    
    # Config file paths (relative to this file)
    agents_config = "config/agents.yaml"
    tasks_config = "config/tasks.yaml"
    
    # ---------- AGENTS ----------
    
    # Verified OpenRouter model IDs (December 2025)
    # Format for CrewAI: "openrouter/{model_id}"
    MODELS = {
        # Fast & cheap - for simple tasks (Bouncer, Handler, Validator)
        "fast": "openrouter/google/gemini-2.0-flash-001",
        
        # Main orchestrator - Gemini 3 Flash
        "butler": "openrouter/google/gemini-3-flash-preview",
        
        # Creative reasoning - Gemini 3 Pro  
        "engineer": "openrouter/google/gemini-3-pro-preview",
        
        # Large context for raw data analysis (7.5M tokens)
        "analyzer": "openrouter/deepseek/deepseek-chat",
        
        # Structured YAML/JSON output
        "creator": "openrouter/deepseek/deepseek-chat",

        # Specialized Personal Assistant (Creative/Human-like)
        "personal_assistant": "openrouter/google/gemini-3-flash-preview",
    }
    
    @agent
    def bouncer(self) -> Agent:
        """Intent validation agent - first line of defense."""
        return Agent(
            config=self.agents_config["bouncer"],  # type: ignore[index]
            llm=self.MODELS["fast"],
            verbose=True,
            allow_delegation=False,  # Bouncer doesn't delegate
        )
    
    @agent
    def butler(self) -> Agent:
        """Main orchestrator agent (manager) with access to HA tools."""
        return Agent(
            config=self.agents_config["butler"],  # type: ignore[index]
            llm=self.MODELS["butler"],
            verbose=True,
            allow_delegation=True,  # Can delegate to specialists
            tools=[
                call_ha_service,
                get_device_states,
                get_user_preferences,
                save_user_preference,
            ],
        )
    
    @agent
    def automation_handler(self) -> Agent:
        """Toggles automations on/off."""
        return Agent(
            config=self.agents_config["automation_handler"],  # type: ignore[index]
            llm=self.MODELS["fast"],
            verbose=True,
            allow_delegation=False,
            tools=[call_ha_service],
        )
    
    @agent
    def automation_creator(self) -> Agent:
        """Creates and deletes automations."""
        return Agent(
            config=self.agents_config["automation_creator"],  # type: ignore[index]
            llm=self.MODELS["creator"],
            verbose=True,
            allow_delegation=False,
            tools=[call_ha_service],
        )
    
    @agent
    def automation_engineer(self) -> Agent:
        """Invents new automations based on patterns."""
        return Agent(
            config=self.agents_config["automation_engineer"],  # type: ignore[index]
            llm=self.MODELS["engineer"],
            verbose=True,
            allow_delegation=False,
        )
    
    @agent
    def analyzer(self) -> Agent:
        """
        Pattern recognition analyst.
        
        Uses get_device_history tool to FETCH raw data from Home Assistant.
        The actual pattern recognition/analysis is done by the LLM itself
        (no external analytics tools) - leveraging DeepSeek's 7.5M context.
        """
        from butler_crew.tools.ha_tools import get_device_history
        return Agent(
            config=self.agents_config["analyzer"],  # type: ignore[index]
            llm=self.MODELS["analyzer"],
            verbose=True,
            allow_delegation=False,
            tools=[get_device_history],  # Fetches data, LLM does the analysis
        )
    
    @agent
    def proposal_validator(self) -> Agent:
        """Filters out denied proposals."""
        return Agent(
            config=self.agents_config["proposal_validator"],  # type: ignore[index]
            llm=self.MODELS["fast"],
            verbose=True,
            allow_delegation=False,
            tools=[check_denied_proposals],
        )
    
    @agent
    def personal_assistant(self) -> Agent:
        """Personal life assistant for calendar, email, navigation, weather, music, and tasks."""
        return Agent(
            config=self.agents_config["personal_assistant"],  # type: ignore[index]
            llm=self.MODELS["personal_assistant"],  # Use specialized model
            verbose=True,
            allow_delegation=False,
            tools=[
                # Calendar tools
                get_upcoming_events,
                create_calendar_event,
                delete_calendar_event,
                find_free_time,
                whats_my_next_meeting,
                # Email tools
                get_recent_emails,
                search_emails,
                send_email,
                reply_to_email,
                summarize_unread_emails,
                # Navigation tools
                get_directions,
                get_eta,
                get_commute_time,
                check_traffic,
                # Weather tools
                get_current_weather,
                get_weather_forecast,
                will_it_rain,
                do_i_need_umbrella,
                # Music tools
                whats_playing,
                play_music,
                pause_music,
                next_song,
                previous_song,
                set_music_volume,
                get_my_playlists,
                # Task tools
                get_my_tasks,
                add_task,
                complete_task,
                whats_on_my_todo,
                add_to_shopping_list,
                get_shopping_list,
                # Alarm tools
                set_alarm,
            ],
        )
    
    # ---------- TASKS ----------
    
    @task
    def validate_intent(self) -> Task:
        """First task: validate if the request is HA-related."""
        return Task(
            config=self.tasks_config["validate_intent"],  # type: ignore[index]
        )
    
    @task
    def process_command(self) -> Task:
        """Main task: process the user command."""
        return Task(
            config=self.tasks_config["process_command"],  # type: ignore[index]
        )
    
    # ---------- CREW ----------
    
    @crew
    def crew(self) -> Crew:
        """
        Creates the Butler crew with sequential process.
        
        Sequential flow: Bouncer validates -> Butler executes.
        Specialists are called by Butler via delegation when needed.
        """
        return Crew(
            agents=self.agents,  # All @agent decorated workers
            tasks=self.tasks,
            process=Process.sequential,  # Sequential for now (simpler)
            verbose=False,
            memory=True,
        )
    
    def kickoff(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """
        Run the crew with the given inputs.
        
        Args:
            inputs: Dictionary with user_message, device_context, language
            
        Returns:
            Dictionary with text, actions, memory_saved, etc.
        """
        result = self.crew().kickoff(inputs=inputs)
        
        # Parse the crew output to our expected format
        try:
            # CrewAI returns structured output
            if hasattr(result, "json_dict") and result.json_dict:
                return result.json_dict
            elif hasattr(result, "raw"):
                # Try to parse raw output as JSON
                import json
                return json.loads(result.raw)
            else:
                return {
                    "text": str(result),
                    "actions": [],
                    "is_valid": True,
                }
        except Exception:
            return {
                "text": str(result),
                "actions": [],
                "is_valid": True,
            }
