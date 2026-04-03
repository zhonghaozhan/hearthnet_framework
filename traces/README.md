# HearthNet LLM Traces

This directory holds recorded outputs from live LLM runs of the demo scenes.

## Purpose

When running demos with `HEARTHNET_MOCK_LLM=false` (live mode), the LLM module
logs each API call's prompt and response here for:

- **Reproducibility**: Compare LLM outputs across runs to verify consistency.
- **Audit**: Every orchestration decision (intent decomposition, conflict
  arbitration, lease evaluation) is traceable to a specific LLM response.
- **Debugging**: When an LLM produces unexpected subtasks or arbitration
  decisions, the full prompt/response pair is available for inspection.

## File naming

Trace files are named: `{scene}-{function}-{timestamp}.json`

Example: `scene1-decomposeIntent-2026-04-03T14-30-00Z.json`

## Structure

Each trace file contains:

```json
{
  "scene": "scene1",
  "function": "decomposeIntent",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "timestamp": "2026-04-03T14:30:00.000Z",
  "prompt": { "system": "...", "user": "..." },
  "response": { "raw": "...", "parsed": {} },
  "latency_ms": 1234
}
```

## .gitignore

Trace files are not committed by default. Add specific traces to git
if they serve as reference outputs for the paper or tests.
