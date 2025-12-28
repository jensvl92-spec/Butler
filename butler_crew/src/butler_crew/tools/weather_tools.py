"""CrewAI tools for weather operations."""

import asyncio
import json
import os
from crewai.tools import tool


def _run_async(coro):
    """Run async coroutine in sync context."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # We're in an async context, use nest_asyncio or run in thread
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                return pool.submit(lambda: asyncio.run(coro)).result()
        else:
            return loop.run_until_complete(coro)
    except RuntimeError:
        return asyncio.run(coro)


@tool("get_current_weather")
def get_current_weather(location: str) -> str:
    """
    Get current weather for a location.
    
    Args:
        location: City name, e.g., "London" or "Bangkok, Thailand"
    
    Returns:
        JSON with temperature, conditions, humidity, wind
    """
    from butler_crew.services.integrations.weather.openweather import get_weather_provider
    
    provider = get_weather_provider()
    if not provider.is_configured():
        return json.dumps({
            "action": "get_current_weather",
            "location": location,
            "status": "not_configured",
            "message": "Weather service not connected. Add OPENWEATHER_API_KEY to .env file.",
        })
    
    try:
        weather = _run_async(provider.get_current_weather(location))
        return json.dumps({
            "action": "get_current_weather",
            "location": weather.location,
            "status": "success",
            "temperature_c": weather.temperature_celsius,
            "feels_like_c": weather.feels_like_celsius,
            "conditions": weather.description,
            "humidity_percent": weather.humidity_percent,
            "wind_speed_mps": weather.wind_speed_mps,
            "clouds_percent": weather.clouds_percent,
        })
    except Exception as e:
        return json.dumps({
            "action": "get_current_weather",
            "location": location,
            "status": "error",
            "message": f"Failed to get weather: {str(e)}",
        })


@tool("get_weather_forecast")
def get_weather_forecast(location: str, days: int = 5) -> str:
    """
    Get weather forecast for upcoming days.
    
    Args:
        location: City name
        days: Number of days to forecast (max 5)
    
    Returns:
        JSON list of daily forecasts
    """
    from butler_crew.services.integrations.weather.openweather import get_weather_provider
    
    provider = get_weather_provider()
    if not provider.is_configured():
        return json.dumps({
            "action": "get_weather_forecast",
            "location": location,
            "status": "not_configured",
            "message": "Weather service not connected. Add OPENWEATHER_API_KEY to .env file.",
        })
    
    try:
        forecasts = _run_async(provider.get_forecast(location, days))
        return json.dumps({
            "action": "get_weather_forecast",
            "location": location,
            "status": "success",
            "forecast": [
                {
                    "date": f.date,
                    "temp_min": f.temp_min,
                    "temp_max": f.temp_max,
                    "conditions": f.description,
                    "precipitation_chance": f.precipitation_chance,
                }
                for f in forecasts
            ],
        })
    except Exception as e:
        return json.dumps({
            "action": "get_weather_forecast",
            "location": location,
            "status": "error",
            "message": f"Failed to get forecast: {str(e)}",
        })


@tool("will_it_rain")
def will_it_rain(location: str, hours: int = 24) -> str:
    """
    Check if rain is expected in the next N hours.
    
    Args:
        location: City name
        hours: Hours to check ahead (default: 24)
    
    Returns:
        JSON with rain probability and timing
    """
    from butler_crew.services.integrations.weather.openweather import get_weather_provider
    
    provider = get_weather_provider()
    if not provider.is_configured():
        return json.dumps({
            "action": "will_it_rain",
            "location": location,
            "status": "not_configured",
            "message": "Weather service not connected. Add OPENWEATHER_API_KEY to .env file.",
        })
    
    try:
        result = _run_async(provider.will_it_rain(location, hours))
        return json.dumps({
            "action": "will_it_rain",
            "location": location,
            "status": "success",
            **result,
        })
    except Exception as e:
        return json.dumps({
            "action": "will_it_rain",
            "location": location,
            "status": "error",
            "message": f"Failed to check rain: {str(e)}",
        })


@tool("do_i_need_umbrella")
def do_i_need_umbrella(location: str = "") -> str:
    """
    Quick check if user needs an umbrella today.
    
    Args:
        location: City name (uses user's default if not specified)
    
    Returns:
        JSON with yes/no recommendation and reasoning
    """
    from butler_crew.services.integrations.weather.openweather import get_weather_provider
    
    # Use default location if not specified
    if not location:
        location = os.getenv("DEFAULT_LOCATION", "Bangkok")
    
    provider = get_weather_provider()
    if not provider.is_configured():
        return json.dumps({
            "action": "do_i_need_umbrella",
            "location": location,
            "status": "not_configured",
            "message": "Weather service not connected. Add OPENWEATHER_API_KEY to .env file.",
        })
    
    try:
        result = _run_async(provider.will_it_rain(location, hours=12))
        need_umbrella = result.get("will_rain", False)
        return json.dumps({
            "action": "do_i_need_umbrella",
            "location": location,
            "status": "success",
            "need_umbrella": need_umbrella,
            "reason": result.get("message", ""),
            "probability_percent": result.get("probability", 0),
        })
    except Exception as e:
        return json.dumps({
            "action": "do_i_need_umbrella",
            "location": location,
            "status": "error",
            "message": f"Failed to check: {str(e)}",
        })

