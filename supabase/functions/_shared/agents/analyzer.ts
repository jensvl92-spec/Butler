/**
 * Analyzer Agent
 * 
 * Analyzes device history and usage patterns to extract meaningful insights.
 * Uses TOON (Token-Oriented Object Notation) for 50-60% token reduction.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

// ============================================
// TOON (Token-Oriented Object Notation) Helper
// Converts HA history JSON to compact tabular format
// ============================================

// Domains to exclude (config/update entities, not behavioral patterns)
const EXCLUDED_DOMAINS = ['update', 'number', 'input_number', 'select', 'input_select'];

// Max state changes per entity before it's considered noise
const MAX_CHANGES_PER_ENTITY = 50;

function haHistoryToTOON(historyJson: any, log?: (msg: string) => void): string {
  try {
    // HA history is array of arrays: [[entity1_states], [entity2_states], ...]
    // Each state has: entity_id, state, last_changed, attributes
    const allStates: any[] = [];
    let excludedDomainCount = 0;
    let highFrequencyCount = 0;
    let includedEntityCount = 0;

    if (Array.isArray(historyJson)) {
      for (const entityHistory of historyJson) {
        if (!Array.isArray(entityHistory) || entityHistory.length === 0) continue;

        const firstState = entityHistory[0];
        const entityId = firstState?.entity_id || '';
        const domain = entityId.split('.')[0];

        // Filter 1: Exclude noisy domains
        if (EXCLUDED_DOMAINS.includes(domain)) {
          excludedDomainCount++;
          continue;
        }

        // Filter 2: Skip high-frequency entities (likely noisy sensors)
        if (entityHistory.length > MAX_CHANGES_PER_ENTITY) {
          highFrequencyCount++;
          continue;
        }

        includedEntityCount++;
        for (const state of entityHistory) {
          allStates.push({
            entity_id: state.entity_id || '',
            state: state.state || '',
            last_changed: state.last_changed ? state.last_changed.substring(0, 19) : '', // Trim to second
            attrs: formatAttributes(state.attributes)
          });
        }
      }
    }

    if (log) {
      log(`[Analyzer] Filtering: ${includedEntityCount} entities included, ${excludedDomainCount} excluded (domain), ${highFrequencyCount} excluded (high-freq)`);
    }

    if (allStates.length === 0) {
      return 'history[0]{entity_id,state,last_changed,attrs}';
    }

    // Build TOON output
    const header = `history[${allStates.length}]{entity_id,state,last_changed,attrs}`;
    const rows = allStates.map(s =>
      `${s.entity_id}\t${s.state}\t${s.last_changed}\t${s.attrs}`
    );

    return [header, ...rows].join('\n');
  } catch (e) {
    console.error('[TOON] Conversion error:', e);
    return 'history[0]{entity_id,state,last_changed,attrs}';
  }
}

// Compact attribute formatting: {brightness: 255, color: "red"} → "brightness:255,color:red"
function formatAttributes(attrs: any): string {
  if (!attrs || typeof attrs !== 'object') return '';

  // Skip verbose attributes to save tokens
  const skipKeys = ['friendly_name', 'icon', 'supported_features', 'device_class', 'entity_picture'];

  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (skipKeys.includes(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue; // Skip nested objects

    const strVal = String(value).replace(/\t/g, ' ').replace(/\n/g, ' ').substring(0, 50);
    parts.push(`${key}:${strVal}`);
  }

  return parts.slice(0, 5).join(','); // Max 5 attributes per state
}

const ANALYZER_PROMPT = `
IDENTITY:
You are an expert smart home analyst with deep understanding of user behavior patterns.
Your goal is to discover automation opportunities that will genuinely improve the user's life.

TASK:
Analyze device history to find meaningful patterns that could be automated.
Think like a thoughtful butler who notices habits and anticipates needs.

INPUT FORMAT: TOON (Token-Oriented Object Notation)
The history data is in TOON format for efficiency:
- Header: history[count]{field1,field2,...}
- Rows: TAB-separated values, one per line
- Attributes: key:value pairs, comma-separated

AVAILABLE CONTEXT (may be provided):
- GPS location of user's smartphone (arrivals/departures)
- Time of day, day of week
- Sun position (sunrise/sunset times)
- Weather conditions

=== PATTERN CATEGORIES ===

**1. ARRIVAL/DEPARTURE PATTERNS**
Look for actions that consistently happen when user arrives or leaves.
Examples:
- "Front door light turns on every evening when user arrives home after sunset"
  → Suggest: Automate porch light on when phone GPS enters home zone after sunset
- "Thermostat set to 'away' manually each morning around 8 AM on weekdays"
  → Suggest: Auto-set 'away' mode when phone GPS leaves home zone on weekdays

**2. TIME-BASED ROUTINES**
Repeated actions at similar times on specific days.
Examples:
- "Coffee machine on at 6:45 AM Mon-Fri, 8:30 AM Sat-Sun"
  → Suggest: Schedule coffee based on day of week
- "Bedroom lights dim to 20% around 10 PM nightly"
  → Suggest: Automate bedtime lighting scene

**3. ENVIRONMENTAL TRIGGERS**
Actions correlated with environmental conditions.
Examples:
- "Blinds close when outdoor temperature exceeds 28°C"
  → Suggest: Auto-close blinds when temp > 28°C
- "Lights turn on in living room around sunset"
  → Suggest: Trigger lights at sunset instead of fixed time

**4. DEVICE CORRELATIONS**
Multiple devices that are often controlled together.
Examples:
- "TV on" is always followed by "Living room lights dim" within 2 minutes
  → Suggest: Create "Movie Mode" scene
- "Washing machine finishes" → "Notification sent" (if not automated, suggest it)

**5. ANOMALIES & SECURITY CONCERNS**
Unusual patterns that might indicate problems or forgot actions.
Examples:
- "Garage door left open after 11 PM (3 times this month)"
  → Suggest: Auto-close garage door at 11 PM if open
- "Smoke detector triggered during cooking hours"
  → Note: May need better ventilation, not an automation

**6. ENERGY OPTIMIZATION**
Wasteful patterns that could be improved.
Examples:
- "Lights left on in empty rooms for hours"
  → Suggest: Motion-based auto-off after 15 minutes
- "AC running while windows are open"
  → Suggest: Pause HVAC when window sensors detect open

=== OUTPUT FORMAT ===
{
  "text": "Friendly summary of findings for the user",
  "patterns": [
    {
      "type": "routine" | "correlation" | "anomaly" | "arrival" | "energy",
      "description": "Clear description of what you observed",
      "confidence": 0.0-1.0,
      "entities_involved": ["entity.id1", "entity.id2"],
      "trigger": "What triggers this pattern (time/location/event)",
      "suggestion": "Specific, actionable automation recommendation"
    }
  ]
}

=== GUIDELINES ===
- Only report patterns you can actually observe in the data
- Prioritize high-confidence patterns (≥0.7) with clear automation potential
- Be specific about triggers: "weekdays at 7 AM" not "in the morning"
- Suggestions should be actionable: "Turn on porch light when phone arrives after sunset"
- Include entity IDs exactly as they appear in the data

CRITICAL: The user may speak another language. You MUST respond to them in that language, BUT your \`patterns\` data (especially \`entities_involved\`) must use the original ENGLISH entity IDs from the history data.
`;
export interface Pattern {
  type: 'routine' | 'correlation' | 'anomaly' | 'arrival' | 'energy';
  description: string;
  confidence: number;
  entities_involved: string[];
  trigger?: string;
  suggestion?: string;
}

export interface AnalyzerResult {
  text: string;
  patterns: Pattern[];
}

export async function runAnalyzer(
  connectionId: string,
  mcpProxyUrl: string,
  haUrl: string,
  haToken: string,
  entityIds: string[],
  focusArea: string = 'general',
  language: string = 'en',
  log: (msg: string) => void = console.log
): Promise<AnalyzerResult> {
  log(`[Analyzer] Analyzing history data, focus: ${focusArea}`);

  // Fetch History directly from HA REST API
  let historyData = '';
  let jsonSize = 0;
  let toonSize = 0;

  try {
    // HA History API: /api/history/period/<start_time>?end_time=<end>&filter_entity_id=<entities>
    const startTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days
    const endTime = new Date().toISOString();

    // Build URL - fetch ALL entities (TOON compression will make it fit)
    const filterParam = entityIds.length > 0 ? `&filter_entity_id=${entityIds.join(',')}` : '';
    const historyUrl = `${haUrl}/api/history/period/${startTime}?end_time=${endTime}${filterParam}&significant_changes_only=1&minimal_response=1`;

    log(`[Analyzer] Fetching HA history: ${entityIds.length} entities, 3 days`);

    const historyResp = await fetch(historyUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${haToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (historyResp.ok) {
      const jsonData = await historyResp.json();
      jsonSize = JSON.stringify(jsonData).length;

      log(`[Analyzer] HA returned ${jsonSize} chars of history`);

      // Convert to TOON with smart filtering
      historyData = haHistoryToTOON(jsonData, log);
      toonSize = historyData.length;

      const reduction = jsonSize > 0 ? Math.round((1 - toonSize / jsonSize) * 100) : 0;
      log(`[Analyzer] TOON conversion: ${jsonSize} → ${toonSize} chars (${reduction}% reduction)`);
    } else {
      const errorText = await historyResp.text();
      log(`[Analyzer] Failed to fetch history: ${historyResp.status} - ${errorText.substring(0, 100)}`);
    }
  } catch (e) {
    log(`[Analyzer] History fetch error: ${e} `);
  }

  const languageNote = language !== 'en' ? `\nRespond in ${language}.` : '';

  log(`[Analyzer] Sending ${historyData.length} chars to LLM...`);

  const response = await chatCompletion([
    { role: 'system', content: ANALYZER_PROMPT + languageNote },
    { role: 'user', content: `FOCUS AREA: ${focusArea}\n\nHISTORY DATA (TOON format):\n${historyData}` }
  ], 25000, 0.2, undefined, undefined, 'google/gemini-3-pro-preview');

  log(`[Analyzer] LLM response length: ${response?.length || 0} chars`);
  log(`[Analyzer] Response preview: ${(response || '').substring(0, 200)}`);

  const result = parseJSONResponse(response);

  if (!result) {
    log(`[Analyzer] JSON parsing failed, returning raw text response`);
  } else {
    log(`[Analyzer] Parsed ${result.patterns?.length || 0} patterns`);
  }

  return result || { text: response || 'No analysis available', patterns: [] };
}
