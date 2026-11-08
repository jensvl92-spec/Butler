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

const WMO_DESCRIPTIONS: Record<number, { nl: string; en: string }> = {
    0: { nl: 'heldere hemel', en: 'clear skies' },
    1: { nl: 'hoofdzakelijk helder', en: 'mainly clear' },
    2: { nl: 'gedeeltelijk bewolkt', en: 'partly cloudy' },
    3: { nl: 'zwaar bewolkt', en: 'overcast' },
    45: { nl: 'mistig', en: 'foggy' },
    48: { nl: 'rijp en mist', en: 'depositing rime fog' },
    51: { nl: 'lichte motregen', en: 'light drizzle' },
    53: { nl: 'matige motregen', en: 'moderate drizzle' },
    55: { nl: 'dichte motregen', en: 'dense drizzle' },
    61: { nl: 'lichte regen', en: 'slight rain' },
    63: { nl: 'matige regen', en: 'moderate rain' },
    65: { nl: 'zware regen', en: 'heavy rain' },
    71: { nl: 'lichte sneeuwval', en: 'slight snowfall' },
    73: { nl: 'matige sneeuwval', en: 'moderate snowfall' },
    75: { nl: 'zware sneeuwval', en: 'heavy snowfall' },
    80: { nl: 'lichte regenbuien', en: 'slight rain showers' },
    81: { nl: 'matige regenbuien', en: 'moderate rain showers' },
    82: { nl: 'hevige regenbuien', en: 'violent rain showers' },
    95: { nl: 'onweer', en: 'thunderstorms' },
    96: { nl: 'onweer met lichte hagel', en: 'thunderstorms with slight hail' },
    99: { nl: 'onweer met zware hagel', en: 'thunderstorms with heavy hail' }
};

function getWMODescription(code: number, lang: string): string {
    const isNl = lang === 'nl' || lang === 'nl-BE';
    const entry = WMO_DESCRIPTIONS[code];
    if (entry) return isNl ? entry.nl : entry.en;
    return isNl ? 'wisselvallig' : 'variable';
}

/**
 * Get current weather for a location.
 */
export async function getCurrentWeather(lat: number, lon: number, lang: string = 'en'): Promise<CurrentWeather> {
    if (OPENWEATHER_API_KEY) {
        try {
            const url = `${BASE_URL}/weather?lat=${lat}&lon=${lon}&units=metric&lang=${lang}&appid=${OPENWEATHER_API_KEY}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                return {
                    location: data.name || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
                    temp: Math.round(data.main.temp),
                    feels_like: Math.round(data.main.feels_like),
                    humidity: data.main.humidity,
                    description: data.weather[0].description,
                    icon: data.weather[0].icon,
                    wind_speed: data.wind.speed
                };
            }
        } catch {
            // Fall through to Open-Meteo
        }
    }

    // Keyless Open-Meteo provider
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Weather API error: ${res.status}`);
    }
    const data = await res.json();
    const curr = data.current;
    if (!curr) throw new Error("No current weather data returned");

    return {
        location: `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        temp: Math.round(curr.temperature_2m),
        feels_like: Math.round(curr.apparent_temperature),
        humidity: curr.relative_humidity_2m,
        description: getWMODescription(curr.weather_code, lang),
        icon: 'weather',
        wind_speed: Math.round(curr.wind_speed_10m)
    };
}

/**
 * Get 5-day forecast for a location.
 */
export async function getForecast(lat: number, lon: number, lang: string = 'en'): Promise<WeatherForecast> {
    if (OPENWEATHER_API_KEY) {
        try {
            const url = `${BASE_URL}/forecast?lat=${lat}&lon=${lon}&units=metric&lang=${lang}&appid=${OPENWEATHER_API_KEY}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                const dailyMap = new Map<string, any[]>();
                for (const item of data.list) {
                    const date = item.dt_txt.split(' ')[0];
                    if (!dailyMap.has(date)) dailyMap.set(date, []);
                    dailyMap.get(date)!.push(item);
                }

                const days: ForecastDay[] = [];
                for (const [date, items] of dailyMap) {
                    const temps = items.map(i => i.main.temp);
                    const pops = items.map(i => i.pop || 0);
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
                    days: days.slice(0, 5)
                };
            }
        } catch {
            // Fall through to Open-Meteo
        }
    }

    // Keyless Open-Meteo provider
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Forecast API error: ${res.status}`);
    }
    const data = await res.json();
    const daily = data.daily;
    if (!daily || !daily.time) throw new Error("No daily forecast data returned");

    const days: ForecastDay[] = [];
    for (let i = 0; i < Math.min(5, daily.time.length); i++) {
        days.push({
            date: daily.time[i],
            temp_min: Math.round(daily.temperature_2m_min[i]),
            temp_max: Math.round(daily.temperature_2m_max[i]),
            description: getWMODescription(daily.weather_code[i], lang),
            icon: 'weather',
            pop: (daily.precipitation_probability_max[i] || 0) / 100
        });
    }

    return {
        location: `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        days
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
