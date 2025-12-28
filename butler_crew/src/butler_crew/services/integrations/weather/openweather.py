"""OpenWeather API integration provider."""

import os
from datetime import datetime
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx


@dataclass
class WeatherData:
    """Standardized weather data."""
    location: str
    temperature_celsius: float
    feels_like_celsius: float
    humidity_percent: int
    description: str
    icon: str
    wind_speed_mps: float
    clouds_percent: int
    timestamp: datetime
    raw_data: Optional[Dict[str, Any]] = None


@dataclass
class ForecastDay:
    """Daily forecast data."""
    date: str
    temp_min: float
    temp_max: float
    description: str
    icon: str
    precipitation_chance: int


class OpenWeatherProvider:
    """
    OpenWeather API integration.
    
    Requires API key from https://openweathermap.org/api
    Free tier: 1000 calls/day, current weather + 5-day forecast
    """
    
    def __init__(self):
        self._api_key = os.getenv("OPENWEATHER_API_KEY")
        self._base_url = "https://api.openweathermap.org/data/2.5"
    
    def is_configured(self) -> bool:
        """Check if API key is configured."""
        return bool(self._api_key)
    
    def authenticate(self, credentials: Dict[str, Any]) -> bool:
        """Set API key for OpenWeather."""
        try:
            self._api_key = credentials.get("api_key") or os.getenv("OPENWEATHER_API_KEY")
            if not self._api_key:
                raise ValueError("No API key provided")
            return True
        except Exception as e:
            print(f"[OpenWeather] Auth failed: {e}")
            return False
    
    async def get_current_weather(
        self,
        location: str,
        units: str = "metric",
    ) -> WeatherData:
        """
        Get current weather for a location.
        
        Args:
            location: City name, e.g., "London" or "Bangkok,TH"
            units: 'metric' (Celsius) or 'imperial' (Fahrenheit)
        """
        if not self._api_key:
            raise ValueError("OPENWEATHER_API_KEY not configured")
        
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self._base_url}/weather",
                params={
                    "q": location,
                    "appid": self._api_key,
                    "units": units,
                },
                timeout=10.0,
            )
            response.raise_for_status()
            data = response.json()
            
            return WeatherData(
                location=data.get("name", location),
                temperature_celsius=data["main"]["temp"],
                feels_like_celsius=data["main"]["feels_like"],
                humidity_percent=data["main"]["humidity"],
                description=data["weather"][0]["description"],
                icon=data["weather"][0]["icon"],
                wind_speed_mps=data["wind"]["speed"],
                clouds_percent=data["clouds"]["all"],
                timestamp=datetime.now(),
                raw_data=data,
            )
    
    async def get_forecast(
        self,
        location: str,
        days: int = 5,
        units: str = "metric",
    ) -> List[ForecastDay]:
        """
        Get weather forecast for upcoming days.
        
        Args:
            location: City name
            days: Number of days (max 5 on free tier)
            units: 'metric' or 'imperial'
        """
        if not self._api_key:
            raise ValueError("OPENWEATHER_API_KEY not configured")
        
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self._base_url}/forecast",
                params={
                    "q": location,
                    "appid": self._api_key,
                    "units": units,
                    "cnt": min(days * 8, 40),  # 3-hour intervals, max 5 days
                },
                timeout=10.0,
            )
            response.raise_for_status()
            data = response.json()
            
            # Group by day and extract daily min/max
            daily_data: Dict[str, Dict] = {}
            for item in data.get("list", []):
                date_str = item["dt_txt"][:10]  # YYYY-MM-DD
                if date_str not in daily_data:
                    daily_data[date_str] = {
                        "temps": [],
                        "descriptions": [],
                        "icons": [],
                        "rain_probs": [],
                    }
                daily_data[date_str]["temps"].append(item["main"]["temp"])
                daily_data[date_str]["descriptions"].append(item["weather"][0]["description"])
                daily_data[date_str]["icons"].append(item["weather"][0]["icon"])
                daily_data[date_str]["rain_probs"].append(item.get("pop", 0) * 100)
            
            forecasts = []
            for date_str, day_info in list(daily_data.items())[:days]:
                forecasts.append(ForecastDay(
                    date=date_str,
                    temp_min=min(day_info["temps"]),
                    temp_max=max(day_info["temps"]),
                    description=max(set(day_info["descriptions"]), key=day_info["descriptions"].count),
                    icon=day_info["icons"][0],
                    precipitation_chance=int(max(day_info["rain_probs"])),
                ))
            
            return forecasts
    
    async def will_it_rain(self, location: str, hours: int = 24) -> Dict[str, Any]:
        """Check if rain is expected in the next N hours."""
        if not self._api_key:
            raise ValueError("OPENWEATHER_API_KEY not configured")
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self._base_url}/forecast",
                    params={
                        "q": location,
                        "appid": self._api_key,
                        "units": "metric",
                        "cnt": min(hours // 3 + 1, 40),
                    },
                    timeout=10.0,
                )
                response.raise_for_status()
                data = response.json()
                
                for item in data.get("list", []):
                    pop = item.get("pop", 0)  # Probability of precipitation
                    if pop > 0.3:  # >30% chance
                        return {
                            "will_rain": True,
                            "probability": int(pop * 100),
                            "when": item["dt_txt"],
                            "message": f"Rain expected at {item['dt_txt']} ({int(pop*100)}% chance)",
                        }
                
                return {
                    "will_rain": False,
                    "probability": 0,
                    "when": None,
                    "message": f"No rain expected in the next {hours} hours",
                }
        except Exception as e:
            return {
                "will_rain": None,
                "probability": None,
                "when": None,
                "message": f"Could not check weather: {str(e)}",
            }


# Singleton instance for easy access
_provider: Optional[OpenWeatherProvider] = None


def get_weather_provider() -> OpenWeatherProvider:
    """Get or create the OpenWeather provider instance."""
    global _provider
    if _provider is None:
        _provider = OpenWeatherProvider()
    return _provider

