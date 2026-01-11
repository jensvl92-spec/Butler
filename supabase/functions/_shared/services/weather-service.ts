/**
 * Weather Service
 * 
 * Fetches weather data from OpenWeatherMap API.
 */

const OPENWEATHER_API_KEY = Deno.env.get('OPENWEATHER_API_KEY') || '';
const BASE_URL = 'https://api.openweathermap.org/data/2.5';

export interface CurrentWeather {
    location: string;
    temp: number;
    feels_like: number;
    humidity: number;
    description: string;
    icon: string;
    wind_speed: number;
}

export interface ForecastDay {
    date: string;
    temp_min: number;
    temp_max: number;
    description: string;
    icon: string;
    pop: number; // Probability of precipitation (0-1)
}

export interface WeatherForecast {
    location: string;
    days: ForecastDay[];
}

/**
 * Get current weather for a location.
 */
export async function getCurrentWeather(lat: number, lon: number, lang: string = 'en'): Promise<CurrentWeather> {
    const url = `${BASE_URL}/weather?lat=${lat}&lon=${lon}&units=metric&lang=${lang}&appid=${OPENWEATHER_API_KEY}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`);
    }

    const data = await response.json();

    return {
        location: data.name,
        temp: Math.round(data.main.temp),
        feels_like: Math.round(data.main.feels_like),
        humidity: data.main.humidity,
        description: data.weather[0].description,
        icon: data.weather[0].icon,
        wind_speed: data.wind.speed
    };
}

/**
 * Get 5-day forecast for a location.
 */
export async function getForecast(lat: number, lon: number, lang: string = 'en'): Promise<WeatherForecast> {
    const url = `${BASE_URL}/forecast?lat=${lat}&lon=${lon}&units=metric&lang=${lang}&appid=${OPENWEATHER_API_KEY}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Forecast API error: ${response.status}`);
    }

    const data = await response.json();

    // Group by day and get daily summary
    const dailyMap = new Map<string, any[]>();
    for (const item of data.list) {
        const date = item.dt_txt.split(' ')[0];
        if (!dailyMap.has(date)) {
            dailyMap.set(date, []);
        }
        dailyMap.get(date)!.push(item);
    }

    const days: ForecastDay[] = [];
    for (const [date, items] of dailyMap) {
        const temps = items.map(i => i.main.temp);
        const pops = items.map(i => i.pop || 0);
        // Use midday description if available
        const midday = items.find(i => i.dt_txt.includes('12:00')) || items[0];

        days.push({
            date,
            temp_min: Math.round(Math.min(...temps)),
            temp_max: Math.round(Math.max(...temps)),
            description: midday.weather[0].description,
            icon: midday.weather[0].icon,
            pop: Math.max(...pops)
        });
    }

    return {
        location: data.city.name,
        days: days.slice(0, 5) // Limit to 5 days
    };
}

/**
 * Format weather for natural language response.
 */
export function formatWeatherText(weather: CurrentWeather, lang: string = 'en'): string {
    if (lang === 'nl' || lang === 'nl-BE') {
        return `Het is nu ${weather.temp}°C in ${weather.location} (voelt als ${weather.feels_like}°C). ${weather.description}. Luchtvochtigheid: ${weather.humidity}%, wind: ${weather.wind_speed} m/s.`;
    }
    return `Currently ${weather.temp}°C in ${weather.location} (feels like ${weather.feels_like}°C). ${weather.description}. Humidity: ${weather.humidity}%, wind: ${weather.wind_speed} m/s.`;
}

/**
 * Check if rain is expected in the forecast.
 */
export function willItRain(forecast: WeatherForecast): { today: boolean; tomorrow: boolean } {
    const today = forecast.days[0];
    const tomorrow = forecast.days[1];

    return {
        today: today ? today.pop > 0.3 : false,
        tomorrow: tomorrow ? tomorrow.pop > 0.3 : false
    };
}
