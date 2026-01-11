/**
 * Energy Scheduler - Smart electricity price optimization
 * 
 * Advanced Features:
 * - Target-Based Charging (calculates duration from battery %)
 * - Solar Priority (checks solar forecasts)
 * - Thermal Pre-heating (overheats house before price spikes)
 * 
 * Endpoints:
 * - GET  /prices          - Get electricity prices for next 24-48h
 * - GET  /optimal-window  - Find cheapest N-hour window
 * - GET  /preheat         - Check if pre-heating is recommended
 * - POST /preheat         - Schedule pre-heating automation
 * - POST /schedule        - Create scheduled automation (smart)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2.38.4"

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const PRICE_SENSOR_PATTERNS = [
    { pattern: /^sensor\.nordpool/, name: 'Nordpool', priceAttr: 'current_price', forecastAttr: 'today' },
    { pattern: /^sensor\.tibber.*price/, name: 'Tibber', priceAttr: null, forecastAttr: 'price_level' },
    { pattern: /^sensor\.octopus.*current.*rate/, name: 'Octopus', priceAttr: null, forecastAttr: null },
    { pattern: /^sensor\.entsoe/, name: 'ENTSO-E', priceAttr: 'current_price', forecastAttr: 'prices' },
    { pattern: /^sensor\.amber/, name: 'Amber', priceAttr: 'price', forecastAttr: null },
    { pattern: /price.*kwh|electricity.*price|energy.*price/i, name: 'Generic', priceAttr: null, forecastAttr: null }
];

interface PricePoint {
    time: Date;
    price: number;
    unit: string;
}

interface OptimalWindow {
    start: Date;
    end: Date;
    avgPrice: number;
    totalHours: number;
    savings: number;
}

function jsonResponse(data: any, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function detectPriceSensor(states: any[]): { entity: any; provider: string } | null {
    for (const pattern of PRICE_SENSOR_PATTERNS) {
        const match = states.find(s =>
            pattern.pattern.test(s.entity_id) &&
            (s.attributes?.unit_of_measurement?.includes('/kWh') ||
                s.attributes?.unit_of_measurement?.includes('ct') ||
                s.entity_id.includes('price'))
        );
        if (match) return { entity: match, provider: pattern.name };
    }
    return null;
}

function parsePriceForecast(entity: any, provider: string): PricePoint[] {
    if (!entity) return [];

    const prices: PricePoint[] = [];
    const unit = entity.attributes?.unit_of_measurement || '€/kWh';
    const currentPrice = parseFloat(entity.state);
    if (!isNaN(currentPrice)) prices.push({ time: new Date(), price: currentPrice, unit });

    if (provider === 'Nordpool') {
        const today = entity.attributes?.today || [];
        const tomorrow = entity.attributes?.tomorrow || [];
        const now = new Date();
        today.forEach((price: number, hour: number) => {
            const time = new Date(now); time.setHours(hour, 0, 0, 0);
            if (time > now) prices.push({ time, price, unit });
        });
        tomorrow.forEach((price: number, hour: number) => {
            const time = new Date(now); time.setDate(time.getDate() + 1); time.setHours(hour, 0, 0, 0);
            prices.push({ time, price, unit });
        });
    }
    if (provider === 'ENTSO-E' && entity.attributes?.prices) {
        Object.entries(entity.attributes.prices).forEach(([timestamp, price]) => {
            const time = new Date(timestamp);
            if (time > new Date()) prices.push({ time, price: price as number, unit });
        });
    }
    prices.sort((a, b) => a.time.getTime() - b.time.getTime());
    return prices;
}

function findOptimalWindow(prices: PricePoint[], durationHours: number, deadline?: Date): OptimalWindow | null {
    if (prices.length === 0) return null;
    let availablePrices = prices;
    if (deadline) {
        availablePrices = prices.filter(p => p.time.getTime() + (durationHours * 3600000) <= deadline.getTime());
    }
    if (availablePrices.length < Math.ceil(durationHours)) return null;

    let bestStart = 0;
    let bestAvg = Infinity;
    const slices = Math.max(1, availablePrices.length - Math.ceil(durationHours) + 1);

    for (let i = 0; i < slices; i++) {
        const slice = availablePrices.slice(i, i + Math.ceil(durationHours));
        const avg = slice.reduce((sum, p) => sum + p.price, 0) / slice.length;
        if (avg < bestAvg) { bestAvg = avg; bestStart = i; }
    }

    const windowPrices = availablePrices.slice(bestStart, bestStart + Math.ceil(durationHours));
    if (windowPrices.length === 0) return null;

    const start = windowPrices[0].time;
    const end = new Date(start.getTime() + durationHours * 3600000);
    const peakPrice = Math.max(...prices.map(p => p.price));

    return {
        start, end, avgPrice: bestAvg, totalHours: durationHours,
        savings: (peakPrice - bestAvg) * durationHours
    };
}

function detectSolarForecast(states: any[]): any | null {
    return states.find(s =>
        (s.entity_id.includes('solcast') && s.entity_id.includes('forecast_tomorrow')) ||
        (s.entity_id.includes('energy_production_tomorrow'))
    ) || null;
}

function findPreheatWindow(prices: PricePoint[]): OptimalWindow | null {
    const morningPrices = prices.filter(p => {
        const h = p.time.getHours();
        return h >= 3 && h <= 7;
    });

    if (morningPrices.length < 2) return null;

    let bestStart = 0;
    let bestSum = Infinity;
    for (let i = 0; i < morningPrices.length - 1; i++) {
        const sum = morningPrices[i].price + morningPrices[i + 1].price;
        if (sum < bestSum) { bestSum = sum; bestStart = i; }
    }

    const start = morningPrices[bestStart].time;
    return {
        start,
        end: new Date(start.getTime() + 2 * 3600000),
        avgPrice: bestSum / 2,
        totalHours: 2,
        savings: 0
    }
}

// Helper to format time for HA automation (HH:MM)
function formatTimeForHA(date: Date): string {
    return date.toTimeString().slice(0, 5);
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(req.url);
    const path = url.pathname.replace('/energy-scheduler', '');

    try {
        // Get connection_id from query params (GET) or body (POST)
        let connectionId = url.searchParams.get('connection_id');
        let requestBody: any = null;

        if (req.method === 'POST') {
            requestBody = await req.json();
            connectionId = connectionId || requestBody.connection_id;
        }

        if (!connectionId) return jsonResponse({ error: 'connection_id required' }, 400);

        const { data: conn } = await supabase.from('ha_connections').select('*').eq('id', connectionId).single();
        if (!conn) return jsonResponse({ error: 'Connection not found' }, 404);

        // Fetch HA States
        const statesRes = await fetch(`${conn.api_url}/api/states`, { headers: { "Authorization": `Bearer ${conn.api_token}` } });
        if (!statesRes.ok) return jsonResponse({ error: 'Failed to fetch HA states' }, 502);
        const states = await statesRes.json();

        const priceSensor = detectPriceSensor(states);

        // ============================================
        // GET /prices - Get electricity prices
        // ============================================
        if (path === '/prices' && req.method === 'GET') {
            if (!priceSensor) {
                return jsonResponse({
                    error: 'No electricity price sensor found',
                    hint: 'Install Nordpool, Tibber, Octopus, or ENTSO-E integration in Home Assistant'
                }, 404);
            }

            const prices = parsePriceForecast(priceSensor.entity, priceSensor.provider);
            return jsonResponse({
                provider: priceSensor.provider,
                sensor_id: priceSensor.entity.entity_id,
                current_price: parseFloat(priceSensor.entity.state),
                unit: priceSensor.entity.attributes?.unit_of_measurement || '€/kWh',
                prices: prices.map(p => ({ time: p.time.toISOString(), price: p.price })),
                count: prices.length
            });
        }

        // ============================================
        // GET /optimal-window - Find cheapest window
        // ============================================
        if (path === '/optimal-window' && req.method === 'GET') {
            const durationHours = parseInt(url.searchParams.get('duration_hours') || '4');
            const beforeTime = url.searchParams.get('before');

            if (!priceSensor) return jsonResponse({ error: 'No price sensor found' }, 404);

            const prices = parsePriceForecast(priceSensor.entity, priceSensor.provider);

            let deadline: Date | undefined;
            if (beforeTime) {
                if (beforeTime.includes(':') && !beforeTime.includes('T')) {
                    const [hours, minutes] = beforeTime.split(':').map(Number);
                    deadline = new Date();
                    deadline.setHours(hours, minutes, 0, 0);
                    if (deadline < new Date()) deadline.setDate(deadline.getDate() + 1);
                } else {
                    deadline = new Date(beforeTime);
                }
            }

            const optimal = findOptimalWindow(prices, durationHours, deadline);
            if (!optimal) return jsonResponse({ error: 'No suitable window found', available_hours: prices.length }, 404);

            return jsonResponse({
                provider: priceSensor.provider,
                optimal_window: {
                    start: optimal.start.toISOString(),
                    end: optimal.end.toISOString(),
                    duration_hours: optimal.totalHours,
                    avg_price: optimal.avgPrice,
                    unit: priceSensor.entity.attributes?.unit_of_measurement
                },
                comparison: {
                    current_price: parseFloat(priceSensor.entity.state),
                    savings_vs_peak: optimal.savings
                }
            });
        }

        // ============================================
        // GET/POST /preheat - Thermal Pre-heating
        // ============================================
        if (path === '/preheat') {
            const prices = parsePriceForecast(priceSensor?.entity, priceSensor?.provider || 'Generic');
            const window = findPreheatWindow(prices);

            if (req.method === 'GET') {
                if (window) {
                    return jsonResponse({
                        recommended: true,
                        window: { start: window.start.toISOString(), end: window.end.toISOString() },
                        reason: `Price is low (${window.avgPrice.toFixed(2)}) before morning peak.`
                    });
                }
                return jsonResponse({ recommended: false, reason: "No significant price advantage found." });
            }

            if (req.method === 'POST') {
                if (!window) return jsonResponse({ success: false, message: "No pre-heat window found." });

                const climateEntity = requestBody?.climate_entity_id || requestBody?.entity_id;
                if (!climateEntity) return jsonResponse({ error: "climate_entity_id required" }, 400);

                // Get current temperature setpoint
                const climateState = states.find((s: any) => s.entity_id === climateEntity);
                const currentTemp = climateState?.attributes?.temperature || 20;
                const boostTemp = currentTemp + 2;

                const automationId = `preheat_${Date.now()}`;

                const boostOn = {
                    alias: `Pre-heat ON: ${climateEntity}`,
                    trigger: [{ platform: 'time', at: formatTimeForHA(window.start) }],
                    action: [{ service: 'climate.set_temperature', target: { entity_id: climateEntity }, data: { temperature: boostTemp } }],
                    mode: 'single'
                };

                const boostOff = {
                    alias: `Pre-heat OFF: ${climateEntity}`,
                    trigger: [{ platform: 'time', at: formatTimeForHA(window.end) }],
                    action: [{ service: 'climate.set_temperature', target: { entity_id: climateEntity }, data: { temperature: currentTemp } }],
                    mode: 'single'
                };

                await fetch(`${conn.api_url}/api/config/automation/config/${automationId}_on`, {
                    method: 'POST', headers: { "Authorization": `Bearer ${conn.api_token}`, "Content-Type": "application/json" },
                    body: JSON.stringify(boostOn)
                });
                await fetch(`${conn.api_url}/api/config/automation/config/${automationId}_off`, {
                    method: 'POST', headers: { "Authorization": `Bearer ${conn.api_token}`, "Content-Type": "application/json" },
                    body: JSON.stringify(boostOff)
                });
                await fetch(`${conn.api_url}/api/services/automation/reload`, {
                    method: 'POST', headers: { "Authorization": `Bearer ${conn.api_token}` }
                });

                return jsonResponse({
                    success: true,
                    message: `Scheduled pre-heat: ${formatTimeForHA(window.start)} - ${formatTimeForHA(window.end)} (${currentTemp}°→${boostTemp}°→${currentTemp}°)`
                });
            }
        }

        // ============================================
        // POST /schedule - Create scheduled automation
        // ============================================
        if (path === '/schedule' && req.method === 'POST') {
            let { device_entity_id, start_time, duration_minutes, description, optimization } = requestBody || {};

            if (!device_entity_id) return jsonResponse({ error: 'device_entity_id required' }, 400);

            let calculatedDuration = duration_minutes;
            let sourceType = 'grid';

            // 1. SMART DURATION (Target %)
            if (optimization?.target_percent && optimization.battery_entity_id) {
                const battState = states.find((s: any) => s.entity_id === optimization.battery_entity_id);
                if (battState) {
                    const currentPct = parseFloat(battState.state);
                    const targetPct = optimization.target_percent;
                    if (!isNaN(currentPct) && currentPct < targetPct) {
                        const { data: learned } = await supabase
                            .from('charging_params')
                            .select('battery_capacity_kwh, avg_charging_speed_kw')
                            .eq('connection_id', connectionId)
                            .eq('device_entity_id', device_entity_id)
                            .single();

                        const capacity = learned?.battery_capacity_kwh || 75.0;
                        const speed = learned?.avg_charging_speed_kw || 11.0;

                        const neededKwh = (targetPct - currentPct) / 100 * capacity;
                        const hoursNeeded = neededKwh / speed;
                        calculatedDuration = Math.ceil(hoursNeeded * 60);

                        description = `${description || 'Charge'}: ${currentPct.toFixed(0)}% → ${targetPct}% (${hoursNeeded.toFixed(1)}h @ ${speed}kW)`;
                    } else {
                        return jsonResponse({ success: false, message: `Battery at ${currentPct}% already above target ${targetPct}%.` });
                    }
                }
            }

            // 2. SOLAR SURPLUS PRIORITY
            if (optimization?.prefer_solar) {
                const solarForecast = detectSolarForecast(states);
                const forecastKwh = parseFloat(solarForecast?.state || '0');

                if (forecastKwh > 15) {
                    const tomorrowNoon = new Date();
                    tomorrowNoon.setDate(tomorrowNoon.getDate() + 1);
                    tomorrowNoon.setHours(11, 0, 0, 0);
                    start_time = tomorrowNoon.toISOString();
                    sourceType = 'solar';
                    description = (description || '') + ` (Solar ☀️ forecast: ${forecastKwh}kWh)`;
                }
            }

            // 3. PRICE OPTIMIZATION
            if (!start_time && sourceType === 'grid') {
                if (priceSensor) {
                    const prices = parsePriceForecast(priceSensor.entity, priceSensor.provider);
                    const deadline = optimization?.deadline ? new Date(optimization.deadline) : undefined;

                    const optimal = findOptimalWindow(prices, (calculatedDuration || 60) / 60, deadline);
                    if (optimal) {
                        start_time = optimal.start.toISOString();
                        description = (description || '') + ` @ ${optimal.avgPrice.toFixed(3)} ${priceSensor.entity.attributes?.unit_of_measurement}`;
                    }
                }
            }

            if (!start_time) start_time = new Date().toISOString();
            if (!calculatedDuration) calculatedDuration = 60;

            const startDate = new Date(start_time);
            const endDate = new Date(startDate.getTime() + calculatedDuration * 60000);
            const automationId = `energy_sched_${Date.now()}`;

            const turnOnAutomation = {
                alias: `Energy ON: ${device_entity_id}`,
                description: description || 'Butler Energy Scheduler',
                trigger: [{ platform: 'time', at: formatTimeForHA(startDate) }],
                action: [{ service: 'homeassistant.turn_on', target: { entity_id: device_entity_id } }],
                mode: 'single'
            };
            const turnOffAutomation = {
                alias: `Energy OFF: ${device_entity_id}`,
                description: description || 'Butler Energy Scheduler',
                trigger: [{ platform: 'time', at: formatTimeForHA(endDate) }],
                action: [{ service: 'homeassistant.turn_off', target: { entity_id: device_entity_id } }],
                mode: 'single'
            };

            await fetch(`${conn.api_url}/api/config/automation/config/${automationId}_on`, {
                method: 'POST', headers: { "Authorization": `Bearer ${conn.api_token}`, "Content-Type": "application/json" },
                body: JSON.stringify(turnOnAutomation)
            });
            await fetch(`${conn.api_url}/api/config/automation/config/${automationId}_off`, {
                method: 'POST', headers: { "Authorization": `Bearer ${conn.api_token}`, "Content-Type": "application/json" },
                body: JSON.stringify(turnOffAutomation)
            });
            await fetch(`${conn.api_url}/api/services/automation/reload`, {
                method: 'POST', headers: { "Authorization": `Bearer ${conn.api_token}` }
            });

            // Store record
            await supabase.from('energy_schedules').insert({
                connection_id: connectionId,
                device_entity_id,
                start_time: startDate.toISOString(),
                duration_minutes: calculatedDuration,
                target_percent: optimization?.target_percent,
                battery_entity_id: optimization?.battery_entity_id,
                source_type: sourceType,
                status: 'pending'
            });

            // Ensure charging_params entry exists for learning
            await supabase.from('charging_params')
                .upsert({ connection_id: connectionId, device_entity_id }, { onConflict: 'connection_id, device_entity_id' });

            return jsonResponse({
                success: true,
                schedule: {
                    device: device_entity_id,
                    start: startDate.toISOString(),
                    end: endDate.toISOString(),
                    duration_minutes: calculatedDuration,
                    source: sourceType
                },
                description
            });
        }

        return jsonResponse({ error: 'Endpoint not found', path }, 404);

    } catch (err: any) {
        console.error('[Energy Scheduler Error]', err);
        return jsonResponse({ error: err.message }, 500);
    }
});
