# HearthNet

**Persistent Multi-Agent Orchestration for Smart Homes on Commodity Edge Hardware**

HearthNet is a protocol and reference implementation for coordinating multiple AI agents managing smart home devices. It uses Git as an append-only audit log and MQTT for real-time agent communication, ensuring every actuation is authorized, conflict-free, and recoverable.

Orchestration decisions (intent decomposition, conflict arbitration, and lease evaluation) are driven by LLM calls (Claude Sonnet 4.5 or GPT 5.2), with a mock mode for reproducible runs without API keys.

📄 **Paper:** _HearthNet: Persistent Multi-Agent Orchestration for Smart Home on Commodity Edge Hardware_ (CAIS 2026)  
🎬 **Demo Video:** https://www.youtube.com/watch?v=p3ZKDsKifRk 
🌐 **Interactive Demo:** https://hearthnet.vercel.app/

---

## Architecture

```
┌──────────┐     MQTT      ┌──────────┐     MQTT      ┌──────────┐
│  Rupert  │◄────────────► │  Jeeves  │◄────────────► │  Darcy   │
│  (root)  │               │ (HA mgr) │               │ (mobile) │
└────┬─────┘               └────┬─────┘               └────┬─────┘
     │                          │                          │
     │         ┌────────────────┴──────────────────┐       │
     └────────►│           Dewey (Librarian)       │◄──────┘
               │  Git repo · Lease validation ·    │
               │  Conflict detection · Audit log   │
               └───────────────────────────────────┘
```

**Agents:**
- **Rupert** — Root orchestrator. Receives user intent, decomposes into subtasks, arbitrates conflicts.
- **Jeeves** — Home Assistant manager. Controls lights, speakers, climate via HA REST API.
- **Darcy** — Mobile device manager. Controls phone settings via ADB.
- **Dewey** — Librarian. Maintains the Git ground-truth repo, validates leases, detects conflicts, enforces freshness.

## Key Properties

| Property | Mechanism |
|----------|-----------|
| **Authorized actuation** | Lease system — agents must hold a valid lease before actuating any device |
| **Conflict resolution** | Dewey detects conflicting state changes; Rupert arbitrates using Git timeline |
| **Freshness verification** | Every lease is bound to a `base_commit`; stale commits are rejected |
| **Full auditability** | Every event (task, response, lease, execution, conflict, resolution) is a Git commit |
| **Crash recovery** | Agents re-sync from Git HEAD; expired leases cannot be replayed |

## Demo Scenes

### Scene 1: Intent-Driven Coordination
User says "I'm working from home." Rupert uses the LLM to decompose the intent into subtasks, issues leases, agents execute in parallel, all committed to Git.

### Scene 2: Conflict Resolution
A scheduled "evening wind-down" routine fires while WFH mode is active. Jeeves and Darcy both request conflicting state changes. Dewey detects the conflicts, Rupert queries the Git timeline, calls the LLM APIs to arbitrate user-explicit intent takes priority over scheduled routines, and denies both leases.

### Scene 3: Freshness & Authorization Verification
Jeeves crashes and restarts with stale state. It attempts to replay a pre-crash command with an expired lease bound to an old commit. Dewey blocks it with a double safety gate (stale base_commit + expired lease). Even after re-syncing, Rupert denies the request on policy grounds — freshness alone is insufficient; policy coherence is required.

## Quick Start

### Prerequisites
- Node.js ≥ 20
- MQTT broker (e.g., Mosquitto) running on port 1883
- Git

### Setup
```bash
git clone https://github.com/zhonghaozhan/hearthnet_framework.git
cd hearthnet_framework
npm install

# Set the HMAC signing secret (any string, must be consistent across agents)
export HEARTHNET_ROOT_SECRET=your-secret-here

# Configure MQTT credentials (edit protocol/msg.js or set env vars)
export MQTT_HOST=127.0.0.1
export MQTT_USER=your-mqtt-username
export MQTT_PASS=your-mqtt-password
export HEARTHNET_LLM_PROVIDER=anthropic    # or "openai"
export ANTHROPIC_API_KEY=your-key-here
```

### Run the Demo
```bash
# Start the librarian (must be running before demo scenes)
npm run librarian

# In another terminal — run all three scenes interactively
npm run demo

# Or run scenes individually
npm run scene1
npm run scene2
npm run scene3

# Run with a fresh Git repo
npm run demo:reset
```

### Live Visualizer
```bash
npm run visualizer
# Open http://localhost:3456
```

The visualizer shows the Git commit timeline in real-time as agents communicate. Features:
- **Color-coded agents** — each agent has a distinct color
- **Type badges** — TASK, RESPONSE, LEASE_GRANT, LEASE_DENIED, CONFLICT, RESOLUTION, etc.
- **Scene separators** — clear visual breaks between demo scenes
- **Topology graph** — SVG network diagram showing directed agent-to-agent message flow
- **Detail panel** — click any commit to inspect hash, author, timestamp, changed files
- **Replay mode** — step through commits with real-time pacing, adjustable speed (0.5×–4×)
- **Live SSE updates** — new commits appear within ~50ms via `fs.watch`

### Collect Metrics
```bash
node demo/run-metrics.js
```

Runs Scene 2 and Scene 3 five times each, reports completion rates, detection rates, and timing.

## Project Structure

```
hearthnet/
├── protocol/
│   ├── msg.js
│   ├── lease.js
│   ├── llm.js              # LLM integration (Anthropic/OpenAI + mock mode)
│   ├── llm-prompts.js      # System prompts for decomposition, arbitration, lease eval
│   └── message-schema.json
├── traces/                  # Recorded LLM call traces for audit/reproducibility
│   └── README.md
├── .env.example             # Environment variable template
├── demo/
│   ├── demo-common.js          # Shared helpers for demo scripts
│   ├── scene1-coordinated-actuation.js
│   ├── scene2-conflict-resolution.js
│   ├── scene3-freshness-verification.js
│   ├── run-all.sh              # Run all scenes interactively
│   └── run-metrics.js          # Batch metric collection
├── visualizer/
│   ├── server.js               # Express + SSE server, fs.watch on Git repo
│   └── public/
│       ├── index.html
│       ├── style.css
│       ├── app.js              # Client: timeline, topology graph, replay controller
│       └── hearthnet-trace.json # Pre-baked snapshot for static deployment
├── scripts/
│   └── test-lease.js           # Lease unit tests
├── package.json
└── README.md
```

## Evaluation

| Metric | Result |
|--------|--------|
| **Scene 1** — Task completion | 4/4 subtasks |
| **Scene 1** — End-to-end latency | 8 s |
| **Scene 2** — Conflicts detected | 5/5 |
| **Scene 2** — Conflicts resolved | 5/5 |
| **Scene 3** — Stale commands rejected | 5/5 |
| **Scene 3** — Expired leases rejected | 5/5 |
| **Scene 3** — False rejections | 0 |
| **Cross-cutting** — Events persisted | 153/153 |
| **Cross-cutting** — MQTT latency (local) | <1 ms |
| **Cross-cutting** — Git integrity (`fsck`) | OK |

## Hardware

The prototype runs on commodity hardware:
- **Mac mini M4** — Root agent (Rupert), MQTT broker
- **Intel NUC N150** — Home Assistant, Librarian (Dewey), Jeeves
- **Android phone** — Mobile agent (Darcy) via ADB
- **Philips Hue** — Smart lights
- **Network** — Tailscale mesh (WireGuard)

Total cost: ~£400 for the edge compute layer.

## License

MIT

## Citation

Coming soon — paper under review at ACM CAIS 2026.
