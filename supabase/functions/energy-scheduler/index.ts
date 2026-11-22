/**
 * Energy Scheduler - Smart electricity price optimization
 *
 * Endpoints:
 * - GET/POST /prices          - Get electricity prices for next 24-48h
 * - GET/POST /optimal-window (or /windows) - Find cheapest N-hour window
 * - GET/POST /preheat         - Check or schedule thermal pre-heating
 * - POST     /schedule        - Create one-shot scheduled automation
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyRequestAuth, verifyConnectionOwnership, CORS_HEADERS } from '../_shared/auth.ts';
import { fetchHAConfig, fetchHAStates } from '../_shared/ha-api.ts';
import { fetchWithTimeout } from '../_shared/model-registry.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PRICE_SENSOR_PATTERNS = [
    { pattern: /^sensor\.nordpool/, name: 'Nordpool', priceAttr: 'current_price', forecastAttr: 'today' },
    { pattern: /^sensor\.tibber.*price/, name: 'Tibber', priceAttr: null, forecastAttr: 'price_level' },
    { pattern: /^sensor\.octopus.*current.*rate/, name: 'Octopus', priceAttr: null, forecastAttr: null },
    { pattern: /^sensor\.entsoe/, name: 'ENTSO-E', priceAttr: 'current_price', forecastAttr: 'prices' },
    { pattern: /^sensor\.energyzero.*energy.*price/i, name: 'EnergyZero', priceAttr: null, forecastAttr: null },
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
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
}

function detectPriceSensor(states: any[]): { entity: any; provider: string } | null {
    for (const pattern of PRICE_SENSOR_PATTERNS) {
        const match = states.find(s => {
            const id = (s.entity_id || '').toLowerCase();
            const unit = (s.attributes?.unit_of_measurement || '').toLowerCase();
            if (id.includes('gas') || unit.includes('m³') || unit.includes('m3')) return false;
            return pattern.pattern.test(s.entity_id) &&
                (unit.includes('/kwh') || unit.includes('ct') || id.includes('price'));
        });
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
            if (time > new Date()) prices.push({ time, price: Number(price), unit });
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
        (s.entity_id?.includes('solcast') && s.entity_id?.includes('forecast_tomorrow')) ||
        (s.entity_id?.includes('energy_production_tomorrow'))
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
    };
}

/**
 * Format local HH:MM:00 and YYYY-MM-DD in Home Assistant's configured timezone
 * so triggers never fire at wrong UTC offsets and include one-shot date guards!
 */
function formatLocalTimeAndDate(date: Date, timeZone: string): { hhmm: string; ymd: string } {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(date);
        const get = (t: string) => parts.find(p => p.type === t)?.value || '00';
        return {
            hhmm: `${get('hour')}:${get('minute')}:00`,
            ymd: `${get('year')}-${get('month')}-${get('day')}`
        };
    } catch {
        return {
            hhmm: date.toISOString().slice(11, 16) + ':00',
            ymd: date.toISOString().slice(0, 10)
        };
    }
}

async function saveOneShotHAAutomation(
    baseUrl: string,
    token: string,
    automationId: string,
    config: Record<string, any>,
    targetYmd: string
) {
    const withOneShotCondition = {
        ...config,
        condition: [
            ...(config.condition || []),
            {
                condition: 'template',
                value_template: `{{ now().strftime('%Y-%m-%d') == '${targetYmd}' }}`
            }
        ]
    };
    const res = await fetchWithTimeout(`${baseUrl}/api/config/automation/config/${automationId}`, {
        method: 'POST',
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(withOneShotCondition)
    }, 15000);
    if (!res.ok) {
        throw new Error(`HA automation save failed (${res.status}): ${await res.text()}`);
    }
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/energy-scheduler/, '') || '/';

    try {
        const auth = await verifyRequestAuth(req, supabase);
        if (!auth.authorized) return jsonResponse({ error: auth.error }, auth.status || 401);

        let connectionId = url.searchParams.get('connection_id');
        let requestBody: any = {};

        if (req.method === 'POST') {
            const raw = await req.text().catch(() => '');
            if (raw.trim()) {
                try { requestBody = JSON.parse(raw); } catch { requestBody = {}; }
            }
            connectionId = connectionId || requestBody.connection_id;
        }

        if (!connectionId) return jsonResponse({ error: 'connection_id required' }, 400);

        const ownership = await verifyConnectionOwnership(supabase, auth, connectionId);
        if (!ownership.valid) return jsonResponse({ error: ownership.error }, ownership.status || 403);
        const conn = ownership.connection;
        const baseUrl = conn.api_url.replace(/\/+$/, '');

        const [states, haConfig] = await Promise.all([
            fetchHAStates(conn),
            fetchHAConfig(conn)
        ]);
        const haTimeZone = haConfig?.time_zone || 'Europe/Brussels';

        const priceSensor = detectPriceSensor(states);

        // ============================================
        // GET/POST /prices - Get electricity prices
        // ============================================
        if (path === '/prices' || path === '/') {
            if (!priceSensor) {
                return jsonResponse({
                    success: false,
                    message: 'Geen elektriciteitsprijssensor gevonden in Home Assistant (Nordpool, Tibber, EnergyZero, ENTSO-E).',
                    error: 'No electricity price sensor found'
                }, 404);
            }

            const prices = parsePriceForecast(priceSensor.entity, priceSensor.provider);
            return jsonResponse({
                success: true,
                provider: priceSensor.provider,
                sensor_id: priceSensor.entity.entity_id,
                current_price: parseFloat(priceSensor.entity.state),
                unit: priceSensor.entity.attributes?.unit_of_measurement || '€/kWh',
                prices: prices.map(p => ({ time: p.time.toISOString(), price: p.price })),
                count: prices.length,
                message: `Huidige stroomprijs (${priceSensor.provider}): ${priceSensor.entity.state} ${priceSensor.entity.attributes?.unit_of_measurement || '€/kWh'}`
            });
        }

        // ============================================
        // GET/POST /optimal-window or /windows - Find cheapest window
        // ============================================
        if (path === '/optimal-window' || path === '/windows') {
            const durationHours = parseInt(url.searchParams.get('duration_hours') || String(requestBody.duration_hours || '3'), 10);
            const beforeTime = url.searchParams.get('before') || requestBody.before;

            if (!priceSensor) {
                return jsonResponse({
                    success: false,
                    message: 'Geen stroomprijssensor gevonden in Home Assistant.',
                    error: 'No price sensor found'
                }, 404);
            }

            const prices = parsePriceForecast(priceSensor.entity, priceSensor.provider);

            let deadline: Date | undefined;
            if (beforeTime) {
                if (String(beforeTime).includes(':') && !String(beforeTime).includes('T')) {
                    const [hours, minutes] = String(beforeTime).split(':').map(Number);
                    deadline = new Date();
                    deadline.setHours(hours, minutes, 0, 0);
                    if (deadline < new Date()) deadline.setDate(deadline.getDate() + 1);
                } else {
                    deadline = new Date(beforeTime);
                }
            }

            const optimal = findOptimalWindow(prices, durationHours, deadline);
            if (!optimal) {
                return jsonResponse({
                    success: true,
                    provider: priceSensor.provider,
                    current_price: parseFloat(priceSensor.entity.state),
                    unit: priceSensor.entity.attributes?.unit_of_measurement || '€/kWh',
                    available_hours: prices.length,
                    message: `Huidige stroomprijs: ${priceSensor.entity.state} ${priceSensor.entity.attributes?.unit_of_measurement || '€/kWh'} (te weinig vooruitblik-uren voor ${durationHours}u venster).`
                });
            }

            const startLocal = formatLocalTimeAndDate(optimal.start, haTimeZone);
            const endLocal = formatLocalTimeAndDate(optimal.end, haTimeZone);
            const unit = priceSensor.entity.attributes?.unit_of_measurement || '€/kWh';

            return jsonResponse({
                success: true,
                provider: priceSensor.provider,
                optimal_window: {
                    start: optimal.start.toISOString(),
                    end: optimal.end.toISOString(),
                    duration_hours: optimal.totalHours,
                    avg_price: optimal.avgPrice,
                    unit
                },
                comparison: {
                    current_price: parseFloat(priceSensor.entity.state),
                    savings_vs_peak: optimal.savings
                },
                message: `Goedkoopste ${durationHours}u venster: ${startLocal.hhmm.slice(0, 5)}–${endLocal.hhmm.slice(0, 5)} (gem. ${optimal.avgPrice.toFixed(3)} ${unit})`
            });
        }

        // ============================================
        // GET/POST /preheat - Thermal Pre-heating
        // ============================================
        if (path === '/preheat') {
            const prices = parsePriceForecast(priceSensor?.entity, priceSensor?.provider || 'Generic');
            const win = findPreheatWindow(prices);

            if (req.method === 'GET') {
                if (win) {
                    return jsonResponse({
                        recommended: true,
                        window: { start: win.start.toISOString(), end: win.end.toISOString() },
                        reason: `Price is low (${win.avgPrice.toFixed(3)}) before morning peak.`
                    });
                }
                return jsonResponse({ recommended: false, reason: "No significant price advantage found." });
            }

            if (req.method === 'POST') {
                if (!win) return jsonResponse({ success: false, message: "Geen gunstig voorverwarm-venster gevonden." });

                const climateEntity = requestBody?.climate_entity_id || requestBody?.entity_id;
                if (!climateEntity) return jsonResponse({ error: "climate_entity_id required" }, 400);

                const climateState = states.find((s: any) => s.entity_id === climateEntity);
                const currentTemp = Number(climateState?.attributes?.temperature || 20);
                const boostTemp = currentTemp + 2;
                const automationId = `preheat_${Date.now()}`;

                const startLocal = formatLocalTimeAndDate(win.start, haTimeZone);
                const endLocal = formatLocalTimeAndDate(win.end, haTimeZone);

                await saveOneShotHAAutomation(baseUrl, conn.api_token, `${automationId}_on`, {
                    alias: `Pre-heat ON: ${climateEntity}`,
                    trigger: [{ platform: 'time', at: startLocal.hhmm }],
                    action: [{ service: 'climate.set_temperature', target: { entity_id: climateEntity }, data: { temperature: boostTemp } }],
                    mode: 'single'
                }, startLocal.ymd);

                await saveOneShotHAAutomation(baseUrl, conn.api_token, `${automationId}_off`, {
                    alias: `Pre-heat OFF: ${climateEntity}`,
                    trigger: [{ platform: 'time', at: endLocal.hhmm }],
                    action: [{ service: 'climate.set_temperature', target: { entity_id: climateEntity }, data: { temperature: currentTemp } }],
                    mode: 'single'
                }, endLocal.ymd);

                await fetchWithTimeout(`${baseUrl}/api/services/automation/reload`, {
                    method: 'POST',
                    headers: { "Authorization": `Bearer ${conn.api_token}` }
                }, 10000);

                return jsonResponse({
                    success: true,
                    message: `Voorverwarmen ingepland: ${startLocal.hhmm.slice(0, 5)}–${endLocal.hhmm.slice(0, 5)} (${currentTemp}°→${boostTemp}°→${currentTemp}°)`
                });
            }
        }

        // ============================================
        // POST /schedule - Create one-shot scheduled automation
        // ============================================
        if (path === '/schedule' && req.method === 'POST') {
            let { device_entity_id, start_time, duration_minutes, description, optimization } = requestBody || {};
            if (!device_entity_id) return jsonResponse({ error: 'device_entity_id required' }, 400);

            let calculatedDuration = duration_minutes;
            let sourceType = 'grid';

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
                            .maybeSingle();

                        const capacity = learned?.battery_capacity_kwh || 75.0;
                        const speed = learned?.avg_charging_speed_kw || 11.0;
                        const neededKwh = (targetPct - currentPct) / 100 * capacity;
                        const hoursNeeded = neededKwh / speed;
                        calculatedDuration = Math.ceil(hoursNeeded * 60);
                        description = `${description || 'Charge'}: ${currentPct.toFixed(0)}% → ${targetPct}% (${hoursNeeded.toFixed(1)}h @ ${speed}kW)`;
                    } else {
                        return jsonResponse({ success: false, message: `Batterij op ${currentPct}% zit al boven doel ${targetPct}%.` });
                    }
                }
            }

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

            if (!start_time && sourceType === 'grid' && priceSensor) {
                const prices = parsePriceForecast(priceSensor.entity, priceSensor.provider);
                const deadline = optimization?.deadline ? new Date(optimization.deadline) : undefined;
                const optimal = findOptimalWindow(prices, (calculatedDuration || 60) / 60, deadline);
                if (optimal) {
                    start_time = optimal.start.toISOString();
                    description = (description || '') + ` @ ${optimal.avgPrice.toFixed(3)} ${priceSensor.entity.attributes?.unit_of_measurement}`;
                }
            }

            if (!start_time) start_time = new Date().toISOString();
            if (!calculatedDuration) calculatedDuration = 60;

            const startDate = new Date(start_time);
            const endDate = new Date(startDate.getTime() + calculatedDuration * 60000);
            const automationId = `energy_sched_${Date.now()}`;

            const startLocal = formatLocalTimeAndDate(startDate, haTimeZone);
            const endLocal = formatLocalTimeAndDate(endDate, haTimeZone);

            await saveOneShotHAAutomation(baseUrl, conn.api_token, `${automationId}_on`, {
                alias: `Energy ON: ${device_entity_id}`,
                description: description || 'Butler Energy Scheduler',
                trigger: [{ platform: 'time', at: startLocal.hhmm }],
                action: [{ service: 'homeassistant.turn_on', target: { entity_id: device_entity_id } }],
                mode: 'single'
            }, startLocal.ymd);

            await saveOneShotHAAutomation(baseUrl, conn.api_token, `${automationId}_off`, {
                alias: `Energy OFF: ${device_entity_id}`,
                description: description || 'Butler Energy Scheduler',
                trigger: [{ platform: 'time', at: endLocal.hhmm }],
                action: [{ service: 'homeassistant.turn_off', target: { entity_id: device_entity_id } }],
                mode: 'single'
            }, endLocal.ymd);

            await fetchWithTimeout(`${baseUrl}/api/services/automation/reload`, {
                method: 'POST',
                headers: { "Authorization": `Bearer ${conn.api_token}` }
            }, 10000);

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

            await supabase.from('charging_params')
                .upsert({ connection_id: connectionId, device_entity_id }, { onConflict: 'connection_id,device_entity_id' });

            return jsonResponse({
                success: true,
                message: `Ingepland: ${device_entity_id} van ${startLocal.hhmm.slice(0, 5)} tot ${endLocal.hhmm.slice(0, 5)}`,
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
