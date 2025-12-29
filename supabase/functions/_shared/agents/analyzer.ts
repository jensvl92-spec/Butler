/**
 * Analyzer Agent
 * 
 * Analyzes device history and usage patterns to extract meaningful insights.
 * Used by other agents to understand user behavior.
 */

import { chatCompletion, parseJSONResponse } from '../llm-service.ts';

const ANALYZER_PROMPT = `
IDENTITY:
You are a data scientist specializing in smart home behavior analysis.

TASK:
Extract meaningful patterns, routines, and anomalies from device history data.

ANALYSIS TYPES:
* **Correlations**: "TV on" usually implies "Lights off"?
* **Routines**: Coffee machine at 7:00 AM every weekday?
* **Anomalies**: Why was the garage open all night?
* **Usage Peaks**: Which devices are used most and when?

OUTPUT FORMAT:
{
  "text": "Summary of findings for the user",
  "patterns": [
    {
      "type": "routine" | "correlation" | "anomaly",
      "description": "What was observed",
      "confidence": 0.0-1.0,
      "entities_involved": ["entity.id"],
      "suggestion": "Optional automation suggestion"
    }
  ]
}

Be factual and data-driven. Only report patterns you can actually observe in the data.
`;

export interface Pattern {
    type: 'routine' | 'correlation' | 'anomaly';
    description: string;
    confidence: number;
    entities_involved: string[];
    suggestion?: string;
}

export interface AnalyzerResult {
    text: string;
    patterns: Pattern[];
}

export async function runAnalyzer(
    historyData: string,
    focusArea: string = 'general',
    language: string = 'en'
): Promise<AnalyzerResult> {
    console.log(`[Analyzer] Analyzing history data, focus: ${focusArea}`);

    const languageNote = language !== 'en' ? `\nRespond in ${language}.` : '';

    const response = await chatCompletion([
        { role: 'system', content: ANALYZER_PROMPT + languageNote },
        { role: 'user', content: `FOCUS AREA: ${focusArea}\n\nHISTORY DATA:\n${historyData}` }
    ], 800, 0.4);

    const result = parseJSONResponse(response);
    return result || { text: response, patterns: [] };
}
