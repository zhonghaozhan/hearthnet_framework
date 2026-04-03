/**
 * HearthNet LLM Integration
 * 
 * Provides LLM-driven decision-making for orchestration tasks:
 * - Intent decomposition (user command → device subtasks)
 * - Conflict arbitration (competing commands)
 * - Lease request evaluation (policy coherence)
 * 
 * Supports Claude (Anthropic) and OpenAI via environment variables.
 * Falls back to deterministic mock responses when HEARTHNET_MOCK_LLM=true.
 */

const {
  DECOMPOSE_INTENT_PROMPT,
  ARBITRATE_CONFLICT_PROMPT,
  EVALUATE_LEASE_PROMPT,
} = require('./llm-prompts');

// Environment configuration
const MOCK_MODE = process.env.HEARTHNET_MOCK_LLM === 'true';
const LLM_PROVIDER = process.env.HEARTHNET_LLM_PROVIDER || 'anthropic';
const LLM_MODEL = process.env.HEARTHNET_LLM_MODEL || (
  LLM_PROVIDER === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o'
);
const TIMEOUT_MS = 10_000;

const fs = require('fs');
const path = require('path');

let anthropicClient = null;
let openaiClient = null;

// Trace directory for recording LLM call inputs/outputs
const TRACE_DIR = process.env.HEARTHNET_TRACE_DIR || path.join(__dirname, '..', 'traces');
const TRACE_ENABLED = process.env.HEARTHNET_TRACE !== 'false'; // on by default

/**
 * Write a trace file for an LLM call (prompt, response, latency).
 * Traces are JSON files in the traces/ directory for audit and reproducibility.
 */
function writeTrace(fnName, scene, systemPrompt, userMessage, response, latencyMs) {
  if (!TRACE_ENABLED || MOCK_MODE) return;
  try {
    if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${scene || 'call'}-${fnName}-${ts}.json`;
    const trace = {
      function: fnName,
      provider: LLM_PROVIDER,
      model: LLM_MODEL,
      timestamp: new Date().toISOString(),
      latency_ms: latencyMs,
      prompt: { system: systemPrompt.substring(0, 500) + '...', user: userMessage },
      response,
    };
    fs.writeFileSync(path.join(TRACE_DIR, filename), JSON.stringify(trace, null, 2));
  } catch (e) {
    console.error(`[llm.trace] Failed to write trace: ${e.message}`);
  }
}

/**
 * Initialize the LLM client based on provider.
 * Lazy-loaded to avoid import errors when not needed.
 */
function initClient() {
  if (MOCK_MODE) return null;

  if (LLM_PROVIDER === 'anthropic') {
    if (!anthropicClient) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY environment variable required for Anthropic provider');
      }
      const Anthropic = require('@anthropic-ai/sdk');
      anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return anthropicClient;
  } else if (LLM_PROVIDER === 'openai') {
    if (!openaiClient) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable required for OpenAI provider');
      }
      const OpenAI = require('openai');
      openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiClient;
  } else {
    throw new Error(`Unsupported LLM_PROVIDER: ${LLM_PROVIDER}. Use 'anthropic' or 'openai'.`);
  }
}

/**
 * Call the LLM with a system prompt and user message.
 * Returns parsed JSON response.
 * 
 * @param {string} systemPrompt - System instructions
 * @param {string} userMessage - User query/input
 * @returns {Promise<Object>} Parsed JSON response
 */
async function callLLM(systemPrompt, userMessage) {
  const client = initClient();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('LLM call timeout')), TIMEOUT_MS)
  );

  const callPromise = (async () => {
    if (LLM_PROVIDER === 'anthropic') {
      const response = await client.messages.create({
        model: LLM_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock) {
        throw new Error(`Anthropic response contained no text block (got ${response.content.map(b => b.type).join(', ')})`);
      }
      const text = textBlock.text.trim();
      // Strip markdown code fences if present
      const cleaned = text.replace(/^```json?\n?/g, '').replace(/\n?```$/g, '').trim();
      try {
        return JSON.parse(cleaned);
      } catch (parseErr) {
        throw new Error(`Failed to parse LLM JSON response: ${parseErr.message}\nRaw: ${text.substring(0, 200)}`);
      }
    } else if (LLM_PROVIDER === 'openai') {
      const response = await client.chat.completions.create({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        response_format: { type: 'json_object' },
      });

      const text = response.choices[0].message.content.trim();
      return JSON.parse(text);
    }
  })();

  return Promise.race([callPromise, timeoutPromise]);
}

/**
 * Decompose a user command into concrete device subtasks.
 * 
 * @param {string} userCommand - Natural language command
 * @param {Object} deviceState - Current device state from ground truth
 * @param {Object} policy - Current policy configuration
 * @param {Array<string>} availableDevices - List of device IDs
 * @returns {Promise<Array<Object>>} Array of subtask objects
 */
async function decomposeIntent(userCommand, deviceState, policy, availableDevices) {
  if (MOCK_MODE) {
    // Default mock decomposition for work-from-home intent
    if (userCommand.includes("working from home") || userCommand.includes("get the room ready")) {
      return [
        {
          manager: "jeeves",
          target_device: "living_room_lights",
          operation: "set_state",
          desired_state: { brightness: 100, color_temp: "neutral" },
          parameter_envelope: { brightness: [80, 100], color_temp: null },
          description: "Set living room lights to bright neutral for video calls",
        },
        {
          manager: "jeeves",
          target_device: "speakers",
          operation: "set_state",
          desired_state: { volume: 15, source: "ambient" },
          parameter_envelope: { volume: [0, 30] },
          description: "Set speakers to low ambient background",
        },
        {
          manager: "darcy",
          target_device: "phone_focus_timer",
          operation: "app_launch",
          desired_state: { active: true, duration_min: 60 },
          parameter_envelope: { active: true, duration_min: [30, 120] },
          description: "Launch focus timer app and enable do-not-disturb",
        },
        {
          manager: "darcy",
          target_device: "phone_dnd",
          operation: "set_state",
          desired_state: { enabled: true },
          parameter_envelope: { enabled: true },
          description: "Enable do-not-disturb mode on phone",
        },
      ];
    }
    return [];
  }

  const userMessage = `User command: "${userCommand}"

Current device state:
${JSON.stringify(deviceState, null, 2)}

Policy configuration:
${JSON.stringify(policy, null, 2)}

Available devices: ${availableDevices.join(', ')}

Decompose this command into concrete subtasks.`;

  try {
    const start = Date.now();
    const result = await callLLM(DECOMPOSE_INTENT_PROMPT, userMessage);
    const latency = Date.now() - start;
    const subtasks = Array.isArray(result) ? result : (result.subtasks || []);
    writeTrace('decomposeIntent', 'intent', DECOMPOSE_INTENT_PROMPT, userMessage, subtasks, latency);
    console.log(`  [llm] decomposeIntent completed in ${latency}ms (${subtasks.length} subtasks)`);
    return subtasks;
  } catch (err) {
    console.error('[llm.decomposeIntent] Error:', err.message);
    throw new Error(`Intent decomposition failed: ${err.message}`);
  }
}

/**
 * Arbitrate a conflict between competing device commands.
 * 
 * @param {Object} conflictDetail - Conflict information (device, values, sources)
 * @param {string} deviceTimeline - Git timeline showing recent state changes
 * @param {string} activeMode - Currently active mode (e.g., 'work_from_home')
 * @param {Object} policy - Current policy configuration
 * @returns {Promise<Object>} { decision: "grant"|"deny", reasoning: string, ... }
 */
async function arbitrateConflict(conflictDetail, deviceTimeline, activeMode, policy) {
  if (MOCK_MODE) {
    // Deny: explicit user mode takes precedence over scheduled routines
    if (conflictDetail.device === 'living_room_lights' && activeMode === 'work_from_home') {
      return {
        decision: "deny",
        reasoning: "DENIED: Evening wind-down conflicts with active work-from-home mode. " +
                   "WFH was explicitly requested by user (git timeline confirms no override). " +
                   "Scheduled routines do not supersede active user intent. " +
                   "Lights remain at 100% neutral.",
        affected_devices: ["living_room_lights"],
        preserve_state: true,
      };
    }
    // Same principle applies to all devices under active user mode
    if (conflictDetail.device === 'speakers' && activeMode === 'work_from_home') {
      return {
        decision: "deny",
        reasoning: "DENIED: Speaker change to relaxing mode conflicts with active WFH ambient setting. " +
                   "WFH mode is still active. Speakers remain at 15% ambient.",
        affected_devices: ["speakers"],
        preserve_state: true,
      };
    }
    return { decision: "deny", reasoning: "Conflict detected — preserving current state pending user override", affected_devices: [conflictDetail.device || 'unknown'], preserve_state: true };
  }

  const userMessage = `Conflict details:
${JSON.stringify(conflictDetail, null, 2)}

Device timeline (recent commits):
${deviceTimeline}

Active mode: ${activeMode || 'none'}

Policy configuration:
${JSON.stringify(policy, null, 2)}

Arbitrate this conflict.`;

  try {
    const start = Date.now();
    const result = await callLLM(ARBITRATE_CONFLICT_PROMPT, userMessage);
    const latency = Date.now() - start;
    writeTrace('arbitrateConflict', 'conflict', ARBITRATE_CONFLICT_PROMPT, userMessage, result, latency);
    console.log(`  [llm] arbitrateConflict completed in ${latency}ms (decision: ${result.decision})`);
    return result;
  } catch (err) {
    console.error('[llm.arbitrateConflict] Error:', err.message);
    throw new Error(`Conflict arbitration failed: ${err.message}`);
  }
}

/**
 * Evaluate whether a lease request should be granted or denied.
 * 
 * @param {Object} request - Lease request details (device, operation, desired_state)
 * @param {Object} currentState - Current system and device state
 * @param {string} activeMode - Currently active mode
 * @param {Object} policy - Current policy configuration
 * @returns {Promise<Object>} { decision: "grant"|"deny", reasoning: string, parameter_envelope?: object }
 */
async function evaluateLeaseRequest(request, currentState, activeMode, policy) {
  if (MOCK_MODE) {
    // Deny actions that contradict active user-set mode (policy coherence)
    if (request.target_device === 'living_room_lights' && 
        request.desired_state?.brightness === 30 &&
        activeMode === 'work_from_home') {
      return {
        decision: "deny",
        reasoning: "DENIED: Your commit is now current, but WFH mode is still active (set by user in Scene 1). " +
                   "Dimming to 30% contradicts the active work-from-home lighting policy. " +
                   "The evening routine must wait for user mode change or explicit override. " +
                   "Freshness alone is not sufficient — policy coherence is required.",
      };
    }
    // No policy conflict detected — approve
    return { decision: "grant", reasoning: "Request is consistent with current mode and policy constraints" };
  }

  const userMessage = `Lease request:
${JSON.stringify(request, null, 2)}

Current system state:
${JSON.stringify(currentState, null, 2)}

Active mode: ${activeMode || 'none'}

Policy configuration:
${JSON.stringify(policy, null, 2)}

Evaluate this lease request.`;

  try {
    const start = Date.now();
    const result = await callLLM(EVALUATE_LEASE_PROMPT, userMessage);
    const latency = Date.now() - start;
    writeTrace('evaluateLeaseRequest', 'lease-eval', EVALUATE_LEASE_PROMPT, userMessage, result, latency);
    console.log(`  [llm] evaluateLeaseRequest completed in ${latency}ms (decision: ${result.decision})`);
    return result;
  } catch (err) {
    console.error('[llm.evaluateLeaseRequest] Error:', err.message);
    throw new Error(`Lease evaluation failed: ${err.message}`);
  }
}

module.exports = {
  decomposeIntent,
  arbitrateConflict,
  evaluateLeaseRequest,
};
