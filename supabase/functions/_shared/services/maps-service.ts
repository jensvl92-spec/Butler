/**
 * Maps Service
 * 
 * Provides navigation and directions using Google Maps API.
 */

const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') || '';
const ROUTES_API_KEY = Deno.env.get('ROUTES_API_KEY') || GOOGLE_MAPS_API_KEY;
const BASE_URL = 'https://maps.googleapis.com/maps/api';

export interface DirectionsResult {
    origin: string;
    destination: string;
    distance: string;
    duration: string;
    duration_in_traffic?: string;
    steps: string[];
}

export interface ETAResult {
    destination: string;
    duration: string;
    duration_in_traffic?: string;
    arrival_time?: string;
}

/**
 * Get directions between two locations using Routes API (v2) with fallback to legacy.
 */
export async function getDirections(
    origin: string,
    destination: string,
    mode: 'driving' | 'walking' | 'bicycling' | 'transit' = 'driving',
    lang: string = 'en'
): Promise<DirectionsResult> {
    try {
        return await tryRoutesApi(origin, destination, mode, lang);
    } catch (e: any) {
        console.warn(`[MapsService] Routes API failed, trying legacy fallback: ${e.message}`);

        // If it's a 403/disabled error, definitely try legacy
        // Otherwise, it might be a genuinely missing route, but we try legacy anyway for robustness
        try {
            return await tryLegacyDirectionsApi(origin, destination, mode, lang);
        } catch (legacyError: any) {
            // Throw a combined error that helps the user
            throw new Error(`Navigation failed.
1. Routes API error: ${e.message}
2. Directions API error: ${legacyError.message}

Please ensure BOTH 'Routes API' and 'Directions API' are enabled in your Google Cloud Console for project 1043698090132.`);
        }
    }
}

async function tryRoutesApi(
    origin: string,
    destination: string,
    mode: 'driving' | 'walking' | 'bicycling' | 'transit' = 'driving',
    lang: string = 'en'
): Promise<DirectionsResult> {
    const url = 'https://routes.googleapis.com/directions/v2:computeRoutes';

    // Map travel modes
    const travelModeMap: Record<string, string> = {
        'driving': 'DRIVE',
        'walking': 'WALK',
        'bicycling': 'BICYCLE',
        'transit': 'TRANSIT'
    };

    const payload: any = {
        origin: { address: origin },
        destination: { address: destination },
        travelMode: travelModeMap[mode] || 'DRIVE',
        routingPreference: mode === 'driving' ? 'TRAFFIC_AWARE' : 'ROUTING_PREFERENCE_UNSPECIFIED',
        languageCode: lang === 'nl-BE' ? 'nl' : lang, // Handle specific dialects
        units: 'METRIC'
    };

    // If origin is coordinates
    if (origin.includes(',')) {
        const [lat, lng] = origin.split(',').map(s => parseFloat(s.trim()));
        if (!isNaN(lat) && !isNaN(lng)) {
            payload.origin = {
                location: {
                    latLng: { latitude: lat, longitude: lng }
                }
            };
        }
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': ROUTES_API_KEY,
            'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.legs.distanceMeters,routes.legs.duration,routes.legs.steps.navigationInstruction'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const msg = errorData.error?.message || response.statusText;
        throw new Error(`${response.status}: ${msg}`);
    }

    const data = await response.json();

    if (!data.routes || !data.routes.length) throw new Error('No route found');

    const route = data.routes[0];

    // Format distance and duration for backward compatibility
    const totalDistanceKm = (route.distanceMeters / 1000).toFixed(1);
    const totalDurationSeconds = parseInt(route.duration.replace('s', ''));
    const totalDurationText = formatSeconds(totalDurationSeconds, lang);

    return {
        origin: origin,
        destination: destination,
        distance: `${totalDistanceKm} km`,
        duration: totalDurationText,
        duration_in_traffic: totalDurationText, // Routes API with TRAFFIC_AWARE includes traffic in duration
        steps: route.legs?.[0]?.steps?.map((step: any) => step.navigationInstruction?.instructions).filter(Boolean) || []
    };
}

async function tryLegacyDirectionsApi(
    origin: string,
    destination: string,
    mode: 'driving' | 'walking' | 'bicycling' | 'transit' = 'driving',
    lang: string = 'en'
): Promise<DirectionsResult> {
    const baseUrl = 'https://maps.googleapis.com/maps/api/directions/json';
    const url = `${baseUrl}?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=${mode}&language=${lang}&departure_time=now&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' || !data.routes.length) {
        throw new Error(`${data.status}: ${data.error_message || 'No route found'}`);
    }

    const leg = data.routes[0].legs[0];
    return {
        origin: leg.start_address,
        destination: leg.end_address,
        distance: leg.distance.text,
        duration: leg.duration.text,
        duration_in_traffic: leg.duration_in_traffic?.text,
        steps: leg.steps.map((step: any) => step.html_instructions.replace(/<[^>]*>/g, ''))
    };
}

/**
 * Format seconds to a readable string (e.g. "1 uur 30 min" or "45 min").
 */
function formatSeconds(seconds: number, lang: string): string {
    const minutes = Math.round(seconds / 60);
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (lang === 'nl' || lang === 'nl-BE') {
        if (hrs > 0) return `${hrs} uur ${mins} min`;
        return `${mins} min`;
    }

    if (hrs > 0) return `${hrs} hour ${mins} min`;
    return `${mins} min`;
}

/**
 * Get just the ETA to a destination.
 */
export async function getETA(
    origin: string,
    destination: string,
    mode: 'driving' | 'walking' | 'bicycling' | 'transit' = 'driving',
    lang: string = 'en'
): Promise<ETAResult> {
    const directions = await getDirections(origin, destination, mode, lang);

    // Calculate arrival time
    const durationMinutes = parseDurationToMinutes(directions.duration_in_traffic || directions.duration);
    const arrivalTime = new Date(Date.now() + durationMinutes * 60 * 1000);

    return {
        destination: directions.destination,
        duration: directions.duration,
        duration_in_traffic: directions.duration_in_traffic,
        arrival_time: arrivalTime.toLocaleTimeString(lang === 'nl' || lang === 'nl-BE' ? 'nl-NL' : 'en-US', { hour: '2-digit', minute: '2-digit' })
    };
}

/**
 * Get ETA from coordinates.
 */
export async function getETAFromCoords(
    lat: number,
    lon: number,
    destination: string,
    mode: 'driving' | 'walking' | 'bicycling' | 'transit' = 'driving',
    lang: string = 'en'
): Promise<ETAResult> {
    return getETA(`${lat},${lon}`, destination, mode, lang);
}

/**
 * Parse duration string to minutes.
 */
function parseDurationToMinutes(duration: string): number {
    // Example: "1 hour 30 mins" or "45 mins"
    let minutes = 0;
    const hourMatch = duration.match(/(\d+)\s*hour/i);
    const minMatch = duration.match(/(\d+)\s*min/i);

    if (hourMatch) minutes += parseInt(hourMatch[1]) * 60;
    if (minMatch) minutes += parseInt(minMatch[1]);

    return minutes || 30; // Default 30 min if parsing fails
}

/**
 * Format ETA for natural language response.
 */
export function formatETAText(eta: ETAResult, lang: string = 'en'): string {
    const trafficNote = eta.duration_in_traffic && eta.duration_in_traffic !== eta.duration
        ? ` (met verkeer: ${eta.duration_in_traffic})`
        : '';

    if (lang === 'nl' || lang === 'nl-BE') {
        return `Naar ${eta.destination}: ${eta.duration}${trafficNote}. Aankomst rond ${eta.arrival_time}.`;
    }
    return `To ${eta.destination}: ${eta.duration}${trafficNote}. Arrival around ${eta.arrival_time}.`;
}

/**
 * Search for nearby places using Google Places API.
 */
export interface NearbyPlace {
    name: string;
    address: string;
    place_id: string;
    location: { lat: number; lng: number };
    distance?: number;
}

export async function searchNearbyPlaces(
    lat: number,
    lon: number,
    query: string,
    radius: number = 5000 // 5km default
): Promise<NearbyPlace[]> {
    // Use Places API (New) - Text Search endpoint
    // Note: Nearby Search (New) doesn't support text queries, so we use Text Search with location bias
    const url = 'https://places.googleapis.com/v1/places:searchText';

    const requestBody = {
        textQuery: query,
        locationBias: {
            circle: {
                center: { latitude: lat, longitude: lon },
                radius: radius
            }
        },
        maxResultCount: 5
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
            'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.id,places.location'
        },
        body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(`Places API error: ${data.error?.status || response.status} - ${data.error?.message || 'Unknown error'}`);
    }

    if (!data.places || data.places.length === 0) {
        return [];
    }

    return data.places.map((place: any) => ({
        name: place.displayName?.text || '',
        address: place.formattedAddress || '',
        place_id: place.id,
        location: { lat: place.location?.latitude, lng: place.location?.longitude }
    }));
}

/**
 * Resolve a relative destination ("closest X") to a real place.
 * Returns the place address/name if found, or original destination if not relative.
 */
export async function resolveDestination(
    lat: number,
    lon: number,
    destination: string
): Promise<{ resolved: string; isRelative: boolean; place?: NearbyPlace }> {
    // Detect relative queries
    const relativePatterns = /\b(dichtstbijzijnde|closest|nearest|dichtbij|nearby)\b/i;

    if (!relativePatterns.test(destination)) {
        return { resolved: destination, isRelative: false };
    }

    // Extract the place type from the query
    // "dichtstbijzijnde ptt station" -> "ptt station"
    const placeType = destination.replace(relativePatterns, '').trim();

    console.log(`[MapsService] Resolving relative destination: "${placeType}" near ${lat},${lon}`);

    try {
        const places = await searchNearbyPlaces(lat, lon, placeType, 10000); // 10km radius

        if (places.length > 0) {
            const closest = places[0];
            console.log(`[MapsService] Found: "${closest.name}" at ${closest.address}`);
            return {
                resolved: `${closest.name}, ${closest.address}`,
                isRelative: true,
                place: closest
            };
        }

        // No results - return original to let it fail gracefully
        console.warn(`[MapsService] No nearby places found for: "${placeType}"`);
        return { resolved: destination, isRelative: true };
    } catch (e: any) {
        console.error(`[MapsService] Places API error: ${e.message}`);
        return { resolved: destination, isRelative: true };
    }
}
