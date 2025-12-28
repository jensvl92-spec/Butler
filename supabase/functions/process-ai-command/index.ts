
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { chatCompletion, parseJSONResponse } from '../_shared/llm-service.ts'
import { ProcessAICommandRequest, AIResponse, HAConnection, AIAction } from '../_shared/types.ts'
import { fetchHAConfig, getConnectionDetails, getRecentHistory } from '../_shared/ha-api.ts'
import { retrieveMemories, saveMemory, saveChatHistory } from '../_shared/memory-service.ts'
import { executeActionMatrix, scheduleActions } from '../_shared/action-executor.ts'
import { runMorningPlanner } from '../_shared/planner-agent.ts'

// @ts-ignore
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
// @ts-ignore
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function processWithLLM(req: ProcessAICommandRequest, supabase: any, connection: HAConnection): Promise<AIResponse> {
  const [relevantMemories, recentHistory] = await Promise.all([retrieveMemories(req.user_message, supabase), getRecentHistory(req.connection_id, supabase)])
  console.log("[DEBUG] Recent History Content:", recentHistory); // CRITICAL DEBUG

  // Use Shared HA API for time context
  let houseTime = "Unknown (Server UTC)";
  const config = await fetchHAConfig(connection);
  if (config && config.time_zone) {
    houseTime = new Date().toLocaleString('en-US', { timeZone: config.time_zone });
  } else {
    houseTime = new Date().toLocaleString('en-US', { timeZone: 'UTC' }) + " (Server UTC default)";
  }

  const { data: pendingActions } = await supabase.from('scheduled_actions').select('id, title, scheduled_for').eq('connection_id', req.connection_id).eq('status', 'pending').gt('scheduled_for', new Date().toISOString()).limit(10);
  const pendingContext = (pendingActions || []).map((p: any) => `- [ID: ${p.id}] "${p.title}" scheduled for ${new Date(p.scheduled_for).toLocaleString()}`).join("\n");

  const deviceContext = (req.devices || []).map((d) => {
    // Filter attributes to reduce noise and context size
    const safeAttrs: any = {};
    const relevantKeys = [
      'friendly_name', 'description', 'supported_features', // Meta
      'brightness', 'color_temp', // Lights
      'current_position', 'position', // Covers (Blinds)
      'current_temperature', 'temperature', 'hvac_action', // Climate
      'volume_level', 'media_title', 'source', // Media
      'unit_of_measurement', 'battery_level' // Sensors
    ];
    if (d.attributes) {
      relevantKeys.forEach(k => { if (d.attributes[k] !== undefined) safeAttrs[k] = d.attributes[k] });
    }
    const attrs = Object.entries(safeAttrs).map(([k, v]) => {
      const val = typeof v === 'string' ? `"${v}"` : v;
      return `${k}=${val}`;
    }).join(', ');
    return `- ${d.entity_id}: ${d.state} [${attrs}]`
  }).filter((line: string | null) => line !== null).join("\n")
  console.log(`[process-ai-command] Device Context Size: ${deviceContext.length} chars`);
  const serviceContext = Object.entries(req.services || {}).map(([domain, services]) => {
    const list = Array.isArray(services) ? services.map((s: any) => s.service || s).join(", ") : Object.keys(services).join(", ");
    return `${domain}: ${list}`
  }).join("\n")
  const roomContext = (req.rooms || []).map((r) => `- ${r.name}: ${r.description}`).join("\n")
  const userDeviceTime = req.client_timestamp ? new Date(req.client_timestamp).toLocaleString('en-US') + " (User Device Time)" : "Unknown";

  const userContext = `
CONTEXT:
Time Context:
- User Device Time: ${userDeviceTime} (Where the user is)
- House Time: ${houseTime} (Where the devices are)

Current Devices:
${deviceContext}

Available Services:
${serviceContext}

Rooms:
${roomContext}

PENDING SCHEDULED ACTIONS (Use "cancel_action" ID to cancel):
${pendingContext || "No pending actions."}

🧠 RELEVANT MEMORIES (Use to resolve aliases):
${relevantMemories || "No relevant memories found."}

📜 RECENT ACTION HISTORY (Use to undo/revert):
${recentHistory || "No recent history."}

USER MESSAGE (lang: ${req.language}):
${req.user_message}

${req.active_suggestion ? `PENDING SUGGESTION: ${req.active_suggestion.title} - Actions: ${JSON.stringify(req.active_suggestion.actions)}` : ''}
`;

  // 1. Define Tools
  const tools = [
    {
      type: "function",
      function: {
        name: "list_available_automations",
        description: "Fetch a list of all available Home Assistant automations and scripts from the database. Use this to see what tools/actions are available.",
        parameters: { type: "object", properties: {}, required: [] }
      }
    },
    {
      type: "function",
      function: {
        name: "consult_automation_expert",
        description: "EXECUTE this tool ONLY when the user asks for NEW automation ideas, suggestions, or habit optimization. Do NOT use this tool for retrying failed commands, repeating actions, or controlling devices.",
        parameters: { type: "object", properties: {}, required: [] }
      }
    }
  ];

  const systemPrompt = `
# Role & Identity
You are the **Smart Butler**, an advanced AI execution engine for Home Assistant.
Your primary function is to **Control Devices** and **Manage the Home** based on user intent.
You are running in a secure environment where **Precision** and **Safety** are paramount.

## Core Capabilities
- **Control**: Lights, Switches, Covers, Media Players, Climate, and more.
- **Read**: Sensor states (Temperature, Motion, Battery).
- **Schedule**: Perform actions in the future (e.g., "Turn off in 10 minutes").
- **Memory**: Recall user preferences and device aliases.
- **Language**: You MUST speak the user's language: **${req.language || 'English'}**.

---

# Critical Execution Rules

### 1. Ambiguity Resolution (The "It" Rule)
**When the user uses vague terms like "It", "Them", "Ze", "Dat", "Die" (e.g., "Turn them off"):**
1.  **CHECK HISTORY**: You MUST inspect 'RECENT ACTION HISTORY' to see what was last controlled.
2.  **PREFER PHYSICAL**: If the last action involved a physical device (Light, Switch), assume the user refers to that.
3.  **IGNORE AUTOMATIONS**: Do NOT assume "it" refers to the system's automation logic unless explicitly stated.
    *   *User:* "Turn on the kitchen light." -> *AI:* { light.turn_on }
    *   *User:* "Turn it off." -> **CORRECT:** { light.turn_off } | **WRONG:** { automation.turn_off }

### 2. Automation Safety Guardrail
**You have restricted access to \`automation.*\`, \`script.*\`, \`flow.*\`, and \`scene.*\` entities.**
- **STRICT PROHIBITION**: Do NOT turn off/on any automation/script UNLESS the user explicitly uses the keywords: *"Automation", "Routine", "Script", "Flow", "Scene"*.
- **"Turn Everything Off"**: This command applies ONLY to physical devices (Lights, Media), NEVER to system automations.
- **Exception**: You may trigger a script if it is an alias for a scene (e.g., "Good Night" script), but NEVER disable the logic itself.

### 3. History is Truth
**The 'RECENT ACTION HISTORY' log is your source of truth.**
- If the user says "Undo", you must find the last executed action in history and perform the **Inverse Action**.
- If the user says "Retry", you must **Re-Execute** the exact same action from history.
- Do NOT hallucinate new states. Trust the history.

### 4. Scheduling vs Delay (The "Freeze" Rule)
**Do NOT use the "delay" action or Service for durations > 5 seconds.**
- "Delay" freezes the User Interface. ONLY use it for micro-delays (e.g., "Wait 2 seconds").
- **For anything > 5 seconds (e.g., "Turn off in 10 minutes"), you MUST use the "scheduled_actions" array.**


---

### 5. Smart State Management (No Redundancy)
**CRITICAL: Determine device state from 'Current Devices' section, NOT from 'RECENT ACTION HISTORY'.**
- History shows what you *did*, not the *current* reality.
- **Before acting:** Find the device in the 'Current Devices' list and read its \`state\` field (e.g., \`on\`, \`off\`, \`open\`, \`closed\`).
- **Single Device:** If the device is ALREADY in the target state -> **Do NOTHING** and reply "It is already on/off".
- **Multiple Devices:** If controlling a group (e.g. "Kitchen"), **ONLY** include actions for devices that are NOT yet in the target state.
    *   *Example:* User says "Kitchen On". Spot 1 state=on, Spot 2 state=off. -> **Action:** Turn ON Spot 2 only.
- Start your response with "I checked the current state..." to show you verified.

### 6. Long-Term Learning (Memory)
**You have the ability to LEARN from the user.**
- IF the user corrects you (e.g., "Kitchen lights includes the spots"), or sets a preference (e.g., "I like the lights blue"), you MUST save this knowledge.
- **HOW:** Return the knowledge string in the \`"memory_to_save"\` field of your JSON response.
- *Example:* \`"memory_to_save": "User considers 'kitchen lights' to include the spots."\`

---

# Tool Usage Guidelines
You have access to specific tools. Use them wisely:

1.  **\`consult_automation_expert\`**:
    *   **WHEN TO USE**: ONLY when the user asks for *Suggestions*, *Ideas*, *Habit Improvements*, or specific *Automation Creation*.
    *   **FORBIDDEN**: NEVER use this for direct commands ("Turn on light"), retries ("Try again"), or status checks.

2.  **\`list_available_automations\`**:
    *   Use this to explore what scripts/automations are discoverable if the user asks what the house can do.

---

# Output Format
You MUST return a JSON object. Do not output markdown text outside the JSON.

\`\`\`json
{
  "text": "Correct confirmation message.",
  "memory_to_save": "Optional: New knowledge to learn forever.",
  "actions": [
    {
      "type": "call_service",
      "service": "domain.service_name",
      "entity_id": "domain.entity",
      "data": { "key": "value" }
    }
  ],
  "scheduled_actions": [
    {
      "title": "Optional future task",
      "wait_ms": 60000,
      "actions": []
    }
  ]
}
\`\`\`

# Response Scenarios

### Scenario: Direct Control
**User:** "Turn on the kitchen lights."
**Response:**
\`\`\`json
{
  "text": "Turning on the kitchen lights.",
  "actions": [{ "type": "call_service", "service": "light.turn_on", "entity_id": "light.kitchen_main" }]
}
\`\`\`

### Scenario: Ambiguous "Turn it off" (Safety)
**Context:** User previously turned on 'light.living_room'. 'automation.morning' is running.
**User:** "Turn it off."
**Reasoning:** User used "it". History shows 'light.living_room'. Safety Rule protects 'automation.morning'.
**Response:**
\`\`\`json
{
  "text": "Turning off the living room light.",
  "actions": [{ "type": "call_service", "service": "light.turn_off", "entity_id": "light.living_room" }]
}
\`\`\`

### Scenario: Scheduling
**User:** "Turn off the TV in 1 hour."
**Response:**
\`\`\`json
{
  "text": "I'll turn off the TV in one hour.",
  "actions": [],
  "scheduled_actions": [{ "title": "Turn off TV", "wait_ms": 3600000, "actions": [{ "type": "call_service", "service": "media_player.turn_off", "entity_id": "media_player.tv" }] }]
}
\`\`\`
`;

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContext }
  ];

  // Tool Call Loop (Max 3 turns)
  for (let turn = 0; turn < 3; turn++) {
    const response: any = await chatCompletion(messages, 500, 0.5, tools);

    // a) Final Response
    if (response.content && !response.tool_calls) {
      const parsed = parseJSONResponse(response.content);
      // @ts-ignore
      // @ts-ignore
      const debugInfo = (messages as any).tool_debug_info; // Retrieve debug data if stored
      const resultObj = parsed || { text: response.content, actions: [], language: req.language };
      // @ts-ignore
      resultObj.tool_debug_info = debugInfo;
      return resultObj;
    }

    // b) Tool Call
    if (response.tool_calls) {
      const toolCall = response.tool_calls[0];
      const funcName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments || "{}");

      console.log(`🛠️ Butler Tool Call: ${funcName} `, args);

      let result = "Error";

      try {
        if (funcName === 'list_available_automations') {
          const { data, error } = await supabase.from('automations').select('entity_id, alias, description').eq('connection_id', req.connection_id).limit(50);
          if (error) result = `Error: ${error.message} `;
          else {
            const mapped = data.map((d: { entity_id: string; alias: string; description: string; }) => ({
              title: d.alias,
              description: d.description,
              action_to_call: { service: 'script.turn_on', entity_id: d.entity_id }
            }));
            result = JSON.stringify(mapped);
          }
        } else if (funcName === 'consult_automation_expert') {
          console.log("👷‍♂️ Butler Delegating to Expert...");
          const { runConsultantAgent } = await import('../_shared/consultant-agent.ts');

          let contextString = "Context loading...";
          try {
            const dList = (req.devices || []).map(d => d.entity_id).join(', ');
            contextString = `Devices: ${dList} `;
          } catch (e) {/*ignore*/ }

          const consultantResponse = await runConsultantAgent(req.user_message, connection, contextString);

          // Save the Raw Output for Debugging
          // @ts-ignore
          messages.tool_debug_info = consultantResponse.tool_debug_info; // Store strictly for return

          result = JSON.stringify({
            expert_thought: "Pattern Analysis Complete.",
            suggestion_text: consultantResponse.text,
            proposed_actions: consultantResponse.actions
          });
        }
      } catch (toolError: any) {
        console.error(`❌ Tool Execution Failed (${funcName}):`, toolError);
        result = JSON.stringify({ error: `Tool execution failed: ${toolError.message || toolError}` });
      }

      messages.push(response);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: funcName,
        content: result
      });
    }
  }

  // @ts-ignore
  return {
    text: "I ran out of thinking steps processing your request.",
    actions: [],
    language: req.language,
    tool_debug_info: messages.tool_debug_info // Pass through
  };
}

// MAIN HANDLER
// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })
  try {
    const payload: ProcessAICommandRequest = await req.json()
    console.log(`🚀[process - ai - command] Received Request.ConnectionId: ${payload.connection_id?.substring(0, 8)}...UserMessage: "${payload.user_message?.substring(0, 50)}..."`);
    const requestStartTime = Date.now(); // Capture early to minimize drift
    if (!payload.user_message || !payload.connection_id) throw new Error("Missing fields: user_message or connection_id")

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const connection = await getConnectionDetails(payload.connection_id, supabase)

    // --- 🌅 ROUTER: MORNING / PLANNER ---
    // Trigger if user specifically asks for "plan", "morning", "agenda"
    const isPlannerContext = payload.user_message.toLowerCase().match(/plan|agenda|morning|schedule/);
    if (isPlannerContext && !payload.user_message.toLowerCase().match(/turn|switch|set/)) {
      console.log("🔀 Routing to Planner Agent...");

      let contextString = "Context loading...";
      try {
        const { data: recent } = await supabase.from('messages').select('role, content').eq('connection_id', payload.connection_id).order('created_at', { ascending: false }).limit(10);
        const history = (recent || []).reverse().map((m: any) => `${m.role.toUpperCase()}: ${m.content} `).join('\n');
        contextString = `Recent Chat: \n${history} `;
      } catch (e) {
        console.error("Context load error", e);
      }

      const plannerResponse = await runMorningPlanner(payload.user_message, supabase, connection, contextString);

      // Save history & Return immediately (Bypassing standard logic)
      await saveChatHistory(payload, plannerResponse, plannerResponse.actions || [], supabase);
      return new Response(JSON.stringify({
        text: plannerResponse.text,
        actions: plannerResponse.actions || [],
        scheduled_actions: plannerResponse.scheduled_actions
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let aiResponse = await processWithLLM(payload, supabase, connection)

    // --- 🕸️ FIX: Detect "Double JSON" (LLM putting JSON inside 'text' field) ---
    if (typeof aiResponse.text === 'string' && aiResponse.text.trim().startsWith('{')) {
      try {
        const nested = JSON.parse(aiResponse.text);
        if (nested.text && Array.isArray(nested.actions)) {
          console.log("🕸️ Detected Nested JSON! Unwrapping...");
          aiResponse = { ...aiResponse, ...nested, tool_debug_info: aiResponse.tool_debug_info };
        }
      } catch (e) { /* Not JSON, ignore */ }
    }

    if (aiResponse.memory_to_save) await saveMemory(aiResponse.memory_to_save, supabase)

    let executedActions: AIAction[] = []
    const immediateActions = aiResponse.actions || [];

    // We execute immediate actions if server execution is requested OR if they are 'special' actions
    // But note logic change: We just pass EVERYTHING to executeActionMatrix if needed.
    // However, client normally executes standard actions for immediacy.

    const force = immediateActions.filter(a => ['create_automation', 'delete_automation', 'cancel_action'].includes(a.type))
    const normal = immediateActions.filter(a => !['create_automation', 'delete_automation', 'cancel_action'].includes(a.type))

    // Prevent Timeout: Only execute on server if explicitly requested (e.g. via Voice Hardware)
    // Default to Client Execution for speed.
    if (payload.execute_server_side === true && normal.length > 0) executedActions.push(...await executeActionMatrix(normal, connection, supabase))
    if (force.length > 0) executedActions.push(...await executeActionMatrix(force, connection, supabase))

    // Calculate execution time
    const executionTime = Date.now() - requestStartTime;

    // Schedule background tasks if needed (e.g. pattern analysis)
    // We do NOT wait for this.
    // Background tasks would go here
    // analyzePatterns(payload, aiResponse);

    let scheduledTasks = 0;
    if (aiResponse.scheduled_actions && aiResponse.scheduled_actions.length > 0) {
      // Changed to static import
      await scheduleActions(aiResponse.scheduled_actions, payload.connection_id, supabase);
      scheduledTasks = aiResponse.scheduled_actions.length;
    }

    const historySaveResult = await saveChatHistory(payload, aiResponse, executedActions, supabase)

    console.log("🔍 [DEBUG] Full AI Response:", JSON.stringify(aiResponse, null, 2));
    console.log("📤 Sending Response Payload:", JSON.stringify({
      text: aiResponse.text,
      actions: aiResponse.actions,
      reasoning: (aiResponse as any)._reasoning,
      sched: aiResponse.scheduled_actions,
      debug_version: "v2.2-history-debug",
      history_save_error: historySaveResult
    }, null, 2));

    return new Response(JSON.stringify({
      text: aiResponse.text,
      actions: aiResponse.actions,
      language: aiResponse.language,
      memory_saved: !!aiResponse.memory_to_save,
      scheduled_tasks: scheduledTasks,
      scheduled_actions: aiResponse.scheduled_actions,
      debug_version: "v2.2-history-debug",
      // @ts-ignore
      tool_debug_info: aiResponse.tool_debug_info,
      history_save_status: historySaveResult
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
  } catch (error: any) {
    console.error("🔥 [process-ai-command] Fatal Error:", error);
    return new Response(JSON.stringify({
      error: error.message,
      stack: error.stack,
      details: "Check Supabase Function Logs for more info"
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } })
  }
})

