/**
 * Analyzer Agent
 * Analyzes device history and usage patterns using TOON format for 50-60% token reduction.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';
import { fetchWithTimeout } from '../model-registry.ts';

const EXCLUDED_DOMAINS = ['update', 'number', 'input_number', 'select', 'input_select', 'button', 'tts', 'stt'];
const MAX_CHANGES_PER_ENTITY = 50;

function haHistoryToTOON(historyJson: any, log?: (msg: string) => void): string {
  try {
    const allStates: any[] = [];
    let excludedDomainCount = 0;
    let highFrequencyCount = 0;
    let includedEntityCount = 0;

    if (Array.isArray(historyJson)) {
      for (const entityHistory of historyJson) {
        if (!Array.isArray(entityHistory) || entityHistory.length === 0) continue;

        const firstState = entityHistory[0];
        const entityId = firstState?.entity_id || '';
        if (!entityId) continue;
        const domain = entityId.split('.')[0];

        if (EXCLUDED_DOMAINS.includes(domain)) {
          excludedDomainCount++;
          continue;
        }

        if (entityHistory.length > MAX_CHANGES_PER_ENTITY) {
          highFrequencyCount++;
          continue;
        }

        includedEntityCount++;
        for (const state of entityHistory) {
          // NOTE: HA minimal_response=1 omits entity_id on index > 0 — carry entityId forward!
          const ts = state.last_changed || state.last_updated || '';
          allStates.push({
            entity_id: state.entity_id || entityId,
            state: state.state || '',
            last_changed: typeof ts === 'string' ? ts.substring(0, 19) : '',
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

    const capped = allStates.slice(0, 2500);
    const header = `history[${capped.length}]{entity_id,state,last_changed,attrs}`;
    const rows = capped.map(s => `${s.entity_id}\t${s.state}\t${s.last_changed}\t${s.attrs}`);
    return [header, ...rows].join('\n');
  } catch (e) {
    console.error('[TOON] Conversion error:', e);
    return 'history[0]{entity_id,state,last_changed,attrs}';
  }
}

function formatAttributes(attrs: any): string {
  if (!attrs || typeof attrs !== 'object') return '';
  const skipKeys = ['friendly_name', 'icon', 'supported_features', 'device_class', 'entity_picture'];
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (skipKeys.includes(key) || value === null || value === undefined || typeof value === 'object') continue;
    const strVal = String(value).replace(/\t/g, ' ').replace(/\n/g, ' ').substring(0, 50);
    parts.push(`${key}:${strVal}`);
  }
  return parts.slice(0, 5).join(',');
}

const ANALYZER_PROMPT = `
IDENTITY:
You are an expert smart home analyst who discovers real automation opportunities from Home Assistant history.

INPUT FORMAT: TOON (Token-Oriented Object Notation)
- Header: history[count]{entity_id,state,last_changed,attrs}
- Rows: TAB-separated values, one per line

CATEGORIES:
1. ARRIVAL/DEPARTURE PATTERNS (person/device_tracker + lights/climate/locks)
2. TIME-BASED ROUTINES (repeated manual actions at consistent times)
3. ENVIRONMENTAL TRIGGERS (sun/weather/temp correlated with blinds/lights/climate)
4. DEVICE CORRELATIONS (devices controlled together within minutes)
5. SECURITY & ANOMALIES (doors/garages left open at night)
6. ENERGY OPTIMIZATION (lights/HVAC left on when away or unused)

OUTPUT FORMAT (valid JSON ONLY):
{
  "text": "Friendly summary of findings for the user",
  "patterns": [
    {
      "type": "routine" | "correlation" | "anomaly" | "arrival" | "energy",
      "description": "Clear description of what you observed",
      "confidence": 0.0-1.0,
      "entities_involved": ["entity.id1", "entity.id2"],
      "trigger": "What triggers this pattern",
      "suggestion": "Specific, actionable automation recommendation"
    }
  ]
}

GUIDELINES:
- Report ONLY patterns directly observed in the data.
- Prioritize high-confidence patterns (>= 0.7) with clear automation potential.
- Keep original entity_ids verbatim in entities_involved.
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
  _connectionId: string,
  _mcpProxyUrl: string,
  haUrl: string,
  haToken: string,
  entityIds: string[],
  focusArea: string = 'general',
  language: string = 'nl',
  log: (msg: string) => void = console.log
): Promise<AnalyzerResult> {
  log(`[Analyzer] Analyzing history data, focus: ${focusArea}`);

  const baseUrl = haUrl.replace(/\/+$/, '');
  const startTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const endTime = new Date().toISOString();

  // Filter out noisy domains and cap total entities; chunk by 40 to prevent HTTP 414 URI Too Long
  const filteredIds = entityIds
    .filter(id => !EXCLUDED_DOMAINS.includes(id.split('.')[0]))
    .slice(0, 160);

  const combinedHistory: any[] = [];
  const CHUNK_SIZE = 40;

  try {
    if (filteredIds.length === 0) {
      const url = `${baseUrl}/api/history/period/${encodeURIComponent(startTime)}?end_time=${encodeURIComponent(endTime)}&significant_changes_only=1&minimal_response=1`;
      const resp = await fetchWithTimeout(url, {
        headers: { 'Authorization': `Bearer ${haToken}`, 'Content-Type': 'application/json' }
      }, 20000);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data)) combinedHistory.push(...data);
      }
    } else {
      for (let i = 0; i < filteredIds.length; i += CHUNK_SIZE) {
        const chunk = filteredIds.slice(i, i + CHUNK_SIZE);
        const url = `${baseUrl}/api/history/period/${encodeURIComponent(startTime)}?end_time=${encodeURIComponent(endTime)}&filter_entity_id=${encodeURIComponent(chunk.join(','))}&significant_changes_only=1&minimal_response=1`;
        const resp = await fetchWithTimeout(url, {
          headers: { 'Authorization': `Bearer ${haToken}`, 'Content-Type': 'application/json' }
        }, 20000);
        if (resp.ok) {
          const data = await resp.json();
          if (Array.isArray(data)) combinedHistory.push(...data);
        } else {
          log(`[Analyzer] History chunk ${i / CHUNK_SIZE + 1} failed: ${resp.status}`);
        }
      }
    }
  } catch (e) {
    log(`[Analyzer] History fetch error: ${e}`);
  }

  const historyData = haHistoryToTOON(combinedHistory, log);
  if (historyData.startsWith('history[0]')) {
    return { text: 'Niet genoeg bruikbare historiek gevonden voor patroonanalyse.', patterns: [] };
  }

  const languageNote = `\nRespond to the user in ${language.startsWith('nl') ? 'Dutch' : language}.`;
  log(`[Analyzer] Sending ${historyData.length} chars to deep_reasoning tier...`);

  const response = await chatCompletion(
    [
      { role: 'system', content: ANALYZER_PROMPT + languageNote },
      { role: 'user', content: `FOCUS AREA: ${focusArea}\n\nHISTORY DATA (TOON format):\n${historyData}` }
    ],
    8000,
    0.2,
    undefined,
    undefined,
    undefined,
    { effort: 'high' },
    'deep_reasoning'
  );

  const result = parseJSONResponse(typeof response === 'string' ? response : JSON.stringify(response));
  return result || { text: typeof response === 'string' ? response : 'Geen analyse beschikbaar', patterns: [] };
}
