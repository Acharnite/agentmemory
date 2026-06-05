# agentmemory — Design Document
**Version:** 0.1
**Status:** Draft
**Design Authority:** Architects
**Last Reviewed:** 2026-06-03
**Origin:** Adopted (/home/kiffer/project/agentmemory)

> **Retroactive Design Document** — This project was adopted by KodeHold on 2026-06-03.
> It was not originally created with KodeHold. This document retroactively describes
> the existing codebase (v0.9.25) rather than specifying forward design.

---

## 1. Purpose & Scope

### What agentmemory Is

agentmemory is a **persistent memory system for AI coding agents**. It runs as a background daemon that transparently captures what agents do during sessions, compresses observations into searchable memory, and injects relevant context when new sessions begin.

It is not a library, not a framework, and not a database — it is a **self-contained memory server** built on top of [iii-engine](https://github.com/iii-hq/iii). Agents connect via any of three interfaces:

- **REST API** (port 3111) — for programmatic access, hook scripts, and agents that speak HTTP
- **MCP Server** (port 3111, `mcp::tools/*` endpoints) — 53 tools for agents that speak the Model Context Protocol
- **Real-time Viewer** (port 3113) — browser-based dashboard for browsing observations, sessions, and the knowledge graph

### What It Solves

Every AI coding agent forgets everything when the session ends. Built-in agent memory (CLAUDE.md, .cursorrules) caps at ~200 lines and goes stale. agentmemory eliminates the 5-minute "re-explain your stack" overhead at the start of every session by:

1. **Auto-capturing** every tool call, file read/write, command, and conversation via lifecycle hooks
2. **Compressing** raw observations into structured facts, concepts, and narratives
3. **Indexing** via BM25 + vector embeddings + knowledge graph (triple-stream retrieval)
4. **Injecting** relevant context at session start (token-budgeted, ~1,900 tokens/session)
5. **Consolidating** knowledge through a 4-tier memory pipeline (Working → Episodic → Semantic → Procedural)

### Scope Boundaries

| In scope | Out of scope |
|----------|-------------|
| Capturing agent tool calls and outputs | Being a general-purpose database |
| Semantic search over past sessions | Running agentic workloads directly |
| Multi-agent coordination (leases, signals, actions) | Replacing the agent's own LLM runtime |
| Real-time observation viewer | External service orchestration |
| Export/import between instances | Long-term archival storage |
| Team memory sharing | User authentication/authorization (single-token HMAC only) |

### Supported Agents

Works with any agent that supports hooks, MCP, or REST: Claude Code, OpenCode, Codex CLI, Cursor, Gemini CLI, GitHub Copilot CLI, Cline, Roo Code, Windsurf, Warp, Aider, Goose, Kilo Code, and many more — all sharing the same memory server.

---

## 2. Requirements

### Runtime Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Node.js | >= 20 | >= 22 LTS |
| iii-engine binary | v0.11.2 (pinned) | v0.11.2 (no newer versions supported yet) |
| Docker | Optional (alternative engine host) | Docker Desktop |
| Disk | 100 MB for agentmemory + iii-engine | 1 GB for memory data |
| RAM | 256 MB | 512 MB (with local embeddings) |

### Dependencies

**Runtime (mandatory):**
- `iii-sdk` (^0.11.2) — WebSocket client to iii-engine, provides `registerFunction`, `registerTrigger`, `sdk.trigger()`
- `@anthropic-ai/claude-agent-sdk` (^0.3.142) — Claude subscription fallback (opt-in)
- `@anthropic-ai/sdk` (^0.100.1) — Anthropic API client
- `@clack/prompts` (^1.2.0) — CLI prompts/UI
- `dotenv` (^17.4.2) — env file loading
- `zod` (^4.0.0) — schema validation

**Optional dependencies:**
- `@xenova/transformers` (^2.17.2) — local embeddings (offline, free, all-MiniLM-L6-v2)
- `@node-rs/jieba` (^2.0.1) — CJK text segmentation
- `tiny-segmenter` (^0.2.0) — CJK fallback segmenter
- `onnxruntime-node` / `onnxruntime-web` — ONNX runtime for transformers

**Build dependencies:**
- `tsdown` (^0.21.10) — TypeScript → ESM bundler (replaces tsup)
- `tsx` (^4.19.0) — TypeScript executor for dev
- `typescript` (^6.0.3) — TypeScript compiler
- `vitest` (^4.1.6) — test framework

### Ports

| Port | Process | Purpose |
|------|---------|---------|
| 3111 | agentmemory | REST API + MCP HTTP |
| 3112 | iii-engine | Internal streams worker |
| 3113 | agentmemory | Real-time viewer |
| 49134 | iii-engine | WebSocket bridge (worker registration + OTEL) |

### Environment Variables

Key configuration surface (~50+ env vars). Major categories:

| Category | Key env vars |
|----------|-------------|
| LLM Provider | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_API_KEY` |
| Embeddings | `EMBEDDING_PROVIDER` (local, openai, voyage, cohere, gemini, openrouter) |
| Auth | `AGENTMEMORY_SECRET` (HMAC bearer token) |
| Viewer | `AGENTMEMORY_VIEWER_HOST`, `AGENTMEMORY_VIEWER_PORT`, `VIEWER_ALLOWED_ORIGINS`, `VIEWER_ALLOWED_HOSTS` |
| Features | `AGENTMEMORY_AUTO_COMPRESS`, `AGENTMEMORY_INJECT_CONTEXT`, `AGENTMEMORY_SLOTS`, `AGENTMEMORY_REFLECT` |
| Search | `BM25_WEIGHT`, `VECTOR_WEIGHT`, `TOKEN_BUDGET`, `RERANK_ENABLED` |
| Multi-agent | `TEAM_ID`, `USER_ID`, `AGENT_ID`, `AGENTMEMORY_AGENT_SCOPE` |
| Consolidation | `CONSOLIDATION_ENABLED`, `GRAPH_EXTRACTION_ENABLED`, `LESSON_DECAY_ENABLED` |
| Ports | `III_REST_PORT`, `AGENTMEMORY_VIEWER_PORT` |

---

## 3. Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      iii-engine (v0.11.2)                       │
│  ┌───────────────┐  ┌───────────────┐  ┌─────────────────────┐ │
│  │ iii-state     │  │ iii-stream    │  │ iii-observability   │ │
│  │ (SQLite KV)   │  │ (WebSocket)   │  │ (OTEL traces)      │ │
│  └───────┬───────┘  └───────┬───────┘  └──────────┬──────────┘ │
│          │                  │                      │            │
│          └──────────────────┴──────────────────────┘            │
│                            │                                    │
│                     WebSocket :49134                            │
│                            │                                    │
│              ┌─────────────┴─────────────┐                     │
│              │     iii-sdk (client)      │                     │
│              │ registerFunction()        │                     │
│              │ registerTrigger()         │                     │
│              │ sdk.trigger()             │                     │
│              └─────────────┬─────────────┘                     │
└────────────────────────────┼───────────────────────────────────┘
                             │
               ┌─────────────┴───────────────────────────────────┐
               │           agentmemory Worker                     │
               │                                                  │
               │  ┌──────────────────────────────────────────┐    │
               │  │  50+ iii Functions (mem::, api::, mcp::) │    │
               │  │  ┌─────────────────┐ ┌────────────────┐  │    │
               │  │  │ Core Memory     │ │ Search &       │  │    │
               │  │  │ observe,remember │ │ Index BM25,   │  │    │
               │  │  │ compress,forget  │ │ vector, graph  │  │    │
               │  │  │ consolidate       │ │ smart-search   │  │    │
               │  │  └─────────────────┘ └────────────────┘  │    │
               │  │  ┌─────────────────┐ ┌────────────────┐  │    │
               │  │  │ Coordination    │ │ Lifecycle      │  │    │
               │  │  │ actions,leases, │ │ consolidate,   │  │    │
               │  │  │ signals,mesh    │ │ evict, snapshot │  │    │
               │  │  └─────────────────┘ └────────────────┘  │    │
               │  └──────────────────────────────────────────┘    │
               │                                                  │
               │  ┌─────────────┐  ┌─────────────┐               │
               │  │ HTTP Triggers│  │ MCP Server  │               │
               │  │ /agentmemory/*│  │ mcp::tools::*│               │
               │  │ 126 endpoints│  │ 53 tools    │               │
               │  └─────────────┘  └─────────────┘               │
               │                                                  │
               │  ┌──────────────────────────────────────────────┐│
               │  │  Viewer Server (:3113)                      ││
               │  │  Browser dashboard, observation stream,     ││
               │  │  session explorer, memory browser,          ││
               │  │  knowledge graph visualization, health      ││
               │  └──────────────────────────────────────────────┘│
               └──────────────────────────────────────────────────┘
```

### Three Primitives (iii-engine Pattern)

Everything in agentmemory is built on iii-engine's three primitives:

1. **Worker** — The agentmemory process itself, registered as a worker via `iii-sdk`'s `registerWorker()` over WebSocket to port 49134
2. **Function** — Individual memory operations registered via `sdk.registerFunction("mem::do-something", handler)`. Each function receives a typed payload and returns a result. Functions are the ONLY way to interact with memory state.
3. **Trigger** — HTTP endpoints, MCP handlers, cron jobs, and event listeners registered via `sdk.registerTrigger()`. Triggers call functions; functions never call triggers.

This pattern is strictly enforced: **never bypass iii-engine with standalone SQLite or in-process alternatives**.

### Memory Pipeline (Data Flow)

```
Agent Action (tool use, prompt, file read)
  │
  ▼
Hook Script (e.g., post-tool-use.ts)
  │  HTTP POST /agentmemory/observe
  ▼
mem::observe function
  │  1. SHA-256 dedup (5min window)
  │  2. Privacy filter (strip secrets, API keys)
  │  3. Store raw observation
  ▼
mem::compress function (if AGENTMEMORY_AUTO_COMPRESS=true)
  │  LLM call → structured facts + concepts + narrative
  ▼
mem::search indexing
  │  BM25 index update + vector embedding (if provider configured)
  ▼
iii-state KV store (SQLite)
```

### 4-Tier Memory Consolidation

Inspired by human memory processing:

| Tier | Storage | What | Trigger |
|------|---------|------|---------|
| **Working** | `mem:obs:<sessionId>` | Raw observations from tool use | Every PostToolUse hook |
| **Episodic** | `mem:summaries` | Compressed session summaries | Stop/SessionEnd hook |
| **Semantic** | `mem:memories` | Extracted facts and patterns | mem::consolidate |
| **Procedural** | `mem:procedural` | Workflows and decision patterns | mem::consolidate |

Memories decay over time (Ebbinghaus curve). Frequently accessed memories strengthen. Stale memories auto-evict. Contradictions are detected and resolved.

### Port Map

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ REST API │    │ MCP HTTP │    │  Viewer  │
│ :3111    │    │ :3111    │    │ :3113    │
└────┬─────┘    └────┬─────┘    └────┬─────┘
     │               │               │
     └───────────────┼───────────────┘
                     │
          ┌──────────▼──────────┐
          │  iii-engine (:49134) │
          │  Worker registration │
          │  Function triggers   │
          │  KV state (SQLite)   │
          │  Streams (:3112)     │
          └─────────────────────┘
```

### Code Statistics

- **Source files:** 118 TypeScript source files in `src/`
- **Lines of code:** ~21,800
- **Tests:** 950+
- **iii Functions:** 50+
- **REST endpoints:** 126
- **MCP tools:** 53 (8 core visible, 53 with `AGENTMEMORY_TOOLS=all`)
- **MCP resources:** 6
- **MCP prompts:** 3
- **Skills:** 4 (8 in plugin)
- **Hook scripts:** 12 (15 script files including utility modules)
- **KV scopes:** 34+

---

## 4. Component Design

### 4.1 Entry Points

| Entry | File | Purpose |
|-------|------|---------|
| Main worker | `src/index.ts` | Registers all functions, triggers, and starts the viewer. Imported by both CLI and tests. |
| CLI | `src/cli.ts` (~2,800 LOC) | All-in-one CLI: start/stop server, connect agents, install, remove, doctor, demo, upgrade, import-jsonl |
| MCP standalone | `src/mcp/standalone.ts` | MCP-only mode (no full server, just stdio MCP) |
| MCP shim | `src/mcp/server.ts` | MCP server running as HTTP endpoints alongside the REST API |

### 4.2 State Layer (`src/state/`)

The state layer is an abstraction over iii-engine's built-in KV store (SQLite-backed via `iii-state` worker):

| Module | Purpose |
|--------|---------|
| `kv.ts` | `StateKV` class — get/set/update/delete/list operations via `sdk.trigger()` |
| `schema.ts` | KV scope constants (34+ scopes), `generateId()`, `fingerprintId()`, `jaccardSimilarity()` |
| `search-index.ts` | BM25 keyword search index with synonym expansion + CJK support |
| `vector-index.ts` | In-memory vector index, cosine similarity, sharded persistence |
| `hybrid-search.ts` | Triple-stream search (BM25 + Vector + Graph) with RRF fusion |
| `reranker.ts` | Cross-encoder reranking (optional, `RERANK_ENABLED=true`) |
| `index-persistence.ts` | Search index save/load from KV store |
| `keyed-mutex.ts` | Per-key async lock for concurrent access |
| `stemmer.ts` | Word stemming for BM25 tokenization |
| `synonyms.ts` | Synonym expansion for BM25 query |
| `cjk-segmenter.ts` | Chinese/Japanese/Korean text segmentation |
| `memory-utils.ts` | Utility functions for memory display/formatting |

### 4.3 Core Functions (`src/functions/`)

64 function registrations across the following domains:

| Domain | Functions | Key Files |
|--------|-----------|-----------|
| **Memory** | observe, remember, compress, forget, evict | `observe.ts`, `remember.ts`, `compress.ts`, `forget` (via `governance.ts`), `evict.ts` |
| **Search** | search, smart-search, hybrid search, graph retrieval | `smart-search.ts`, `search.ts`, `graph-retrieval.ts`, `query-expansion.ts` |
| **Context** | context, enrich, profile, file-index | `context.ts`, `enrich.ts`, `profile.ts`, `file-index.ts` |
| **Consolidation** | consolidate, consolidation-pipeline, crystallize, reflect | `consolidate.ts`, `consolidation-pipeline.ts`, `crystallize.ts`, `reflect.ts` |
| **Coordination** | actions, leases, signals, routines, checkpoints, frontier, sentinels, sketches | `actions.ts`, `leases.ts`, `signals.ts`, `routines.ts`, `checkpoints.ts`, `frontier.ts`, `sentinels.ts`, `sketches.ts` |
| **Intelligence** | patterns, lessons, facets, insights, verify, cascade, temporal-graph | `patterns.ts`, `lessons.ts`, `facets.ts`, `reflect.ts` (insights), `verify.ts`, `cascade.ts`, `temporal-graph.ts` |
| **Data Management** | export-import, snapshot, claude-bridge, obsidian-export, mesh, team | `export-import.ts`, `snapshot.ts`, `claude-bridge.ts`, `obsidian-export.ts`, `mesh.ts`, `team.ts` |
| **Health/Maintenance** | diagnostics, health monitor, disk-size-manager, recent-searches-sweep, sliding-window, auto-forget, retention | `diagnostics.ts`, `health/monitor.ts`, `disk-size-manager.ts`, `recent-searches-sweep.ts`, `sliding-window.ts`, `auto-forget.ts`, `retention.ts` |
| **Lifecycle** | dedup, privacy, migrate, summarize, slots, working-memory, skill-extract, replay | `dedup.ts`, `privacy.ts`, `migrate.ts`, `summarize.ts`, `slots.ts`, `working-memory.ts`, `skill-extract.ts`, `replay.ts` |
| **Multimodal** | vision-search, image-refs, image-quota-cleanup | `vision-search.ts`, `image-refs.ts`, `image-quota-cleanup.ts` |
| **Graph** | graph, temporal-graph, branch-aware | `graph.ts`, `temporal-graph.ts`, `branch-aware.ts` |

### 4.4 Authentication (`src/auth.ts`)

- Uses HMAC-SHA256 timing-safe comparison (`timingSafeCompare(a, b)`)
- Single shared secret (`AGENTMEMORY_SECRET`) used as bearer token
- All REST endpoints (except `/agentmemory/health`) check auth when secret is set
- Viewer has additional security for non-loopback binds: requires both `AGENTMEMORY_SECRET` and explicit `VIEWER_ALLOWED_HOSTS`

### 4.5 Viewer (`src/viewer/`)

| File | Purpose |
|------|---------|
| `server.ts` | HTTP server (Node.js `http.createServer`), proxy to REST API, CORS, CSP headers, Host header validation |
| `document.ts` | `renderViewerDocument()` — serves the SPA shell with nonce-based CSP |
| `index.html` | The viewer SPA (single-page application) |
| `favicon.svg` | Viewer icon |

The viewer is a single-page JavaScript application that:
- Shows a live observation stream via SSE/WebSocket
- Provides a session explorer with search/filter
- Displays a memory browser with CRUD operations
- Renders a knowledge graph visualization
- Has a health dashboard with runtime stats
- Supports session replay (prompt-tool-result timeline)

### 4.6 Hook Scripts (`src/hooks/`)

15 standalone Node.js scripts that run as subprocesses from agent lifecycle hooks. They communicate with the agentmemory REST API via HTTP:

| Hook Script | Trigger | Output |
|-------------|---------|--------|
| `session-start.ts` | Session starts | Context injection to stdout (when enabled) |
| `session-end.ts` | Session ends | Session summary to REST API |
| `post-tool-use.ts` | After each tool call | Observation capture |
| `post-tool-failure.ts` | Tool call error | Error observation |
| `pre-tool-use.ts` | Before tool call | File enrichment (optional) |
| `pre-compact.ts` | Before context compact | Memory re-injection |
| `prompt-submit.ts` | User prompt submitted | Prompt capture |
| `notification.ts` | Agent notifications | Notification capture |
| `stop.ts` | Agent stop signal | Session finalization |
| `subagent-start.ts` | Sub-agent creation | Sub-agent tracking |
| `subagent-stop.ts` | Sub-agent end | Sub-agent summary |
| `task-completed.ts` | Task completion | Task result capture |
| `post-commit.ts` | Git commit made | Commit linking |
| `_project.ts` | (utility) | Project path resolution |
| `sdk-guard.ts` | (utility) | SDK child context detection |

Two distinct patterns:
- **Context-injecting hooks** (session-start, pre-tool-use, pre-compact): write context to stdout, which Claude Code prepends to the next turn. Use `await fetch()` with timeout.
- **Telemetry-only hooks** (all others): use fire-and-forget `fetch().catch(() => {})` with `setTimeout(exit, 500).unref()` — must not block the agent's next-prompt boundary.

### 4.7 Plugin System (`plugin/`)

| Directory | Purpose |
|-----------|---------|
| `plugin/.claude-plugin/` | Claude Code plugin (12 hooks + 8 skills) |
| `plugin/.codex-plugin/` | Codex CLI plugin (6 hooks + 8 skills) |
| `plugin/opencode/` | OpenCode plugin (22 hooks + 2 slash commands) |
| `plugin/hooks/` | Hook shell scripts referencing the bundled `src/hooks/` scripts |
| `plugin/skills/` | 8 SKILL.md files (remember, recall, recap, handoff, forget, commit-context, commit-history, session-history) |
| `plugin/scripts/` | Utility scripts for hook integration |
| `plugin/plugin.json` | Main plugin manifest |
| `plugin/.mcp.json` | MCP server config for Claude plugin |
| `plugin/.mcp.copilot.json` | MCP server config for Copilot CLI |

### 4.8 Provider System (`src/providers/`)

Pluggable LLM provider architecture with circuit breaker and fallback chain:

| Provider | File | Env Key |
|----------|------|---------|
| No-op (default) | `noop.ts` | No config needed |
| Anthropic | `anthropic.ts` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai.ts` | `OPENAI_API_KEY` |
| Gemini | (via OpenAI-compatible) | `GEMINI_API_KEY` |
| OpenRouter | `openrouter.ts` | `OPENROUTER_API_KEY` |
| MiniMax | `minimax.ts` | `MINIMAX_API_KEY` |
| Agent SDK | `agent-sdk.ts` | Claude subscription fallback (opt-in) |
| Embedding | `embedding/` | `EMBEDDING_PROVIDER` (local, openai, voyage, cohere, gemini, openrouter) |

Architecture:
- `resilient.ts` — ResilientProvider wrapper with circuit breaker (5 failures → open circuit for 30s)
- `fallback-chain.ts` — Ordered fallback chain across providers
- `circuit-breaker.ts` — Circuit breaker pattern with half-open recovery

### 4.9 Config System (`src/config.ts`)

- Loads `~/.agentmemory/.env` file
- Merges with process environment (process env wins)
- Parses multi-value env vars (comma-separated, JSON)
- Provides typed config accessors for all feature flags
- Auto-detects embedding provider, LLM provider kind
- Cost-aware model warnings

### 4.10 CLI (`src/cli.ts`)

~2,800 lines implementing the `agentmemory` CLI command. Key subcommands:

| Command | Description |
|---------|-------------|
| `agentmemory` (no args) | Start the server (REST + MCP + Viewer) |
| `agentmemory stop` | Graceful shutdown (reaps worker + engine pidfile) |
| `agentmemory remove` | Uninstall everything |
| `agentmemory connect <agent>` | Wire MCP + hooks for a specific agent |
| `agentmemory demo` | Seed sample data + prove recall |
| `agentmemory doctor` | Interactive diagnostics + fix prompts |
| `agentmemory import-jsonl` | Import Claude Code transcripts |
| `agentmemory upgrade` | Update runtime dependencies |
| `agentmemory mcp` | Run MCP standalone mode |

### 4.11 Health System (`src/health/`)

| File | Purpose |
|------|---------|
| `monitor.ts` | Health monitor — periodic checks, `/agentmemory/health` + `/agentmemory/livez` endpoints |
| `thresholds.ts` | Health threshold configuration |

### 4.12 Telemetry (`src/telemetry/`)

- `setup.ts` — OTEL configuration, metrics store initialization
- Metrics tracked: function call counts, latency, error rates, memory counts, search performance

---

## 5. Data Model

### 5.1 KV Store Architecture

agentmemory uses iii-engine's built-in **StateModule** (file-based SQLite at `./data/state_store.db`) as its sole persistence layer. There is no separate database — all data (sessions, observations, memories, indices, graph data) is stored as KV pairs within this single SQLite database.

The KV interface (`StateKV` class in `src/state/kv.ts`) wraps `sdk.trigger()` to access five operations:
- `get(scope, key)` — retrieve a single value
- `set(scope, key, value)` — write a single value
- `update(scope, key, ops)` — partial update (JSON path operations)
- `delete(scope, key)` — remove a value
- `list(scope)` — enumerate all values in a scope

### 5.2 KV Scopes

34+ scopes defined in `src/state/schema.ts`:

| Scope Pattern | Content | Example Key |
|---------------|---------|-------------|
| `mem:sessions` | All sessions (array) | `mem:sessions` |
| `mem:obs:<sessionId>` | Raw observations for a session | `mem:obs:sess_abc123` |
| `mem:memories` | All compressed memories (array) | `mem:memories` |
| `mem:summaries` | Session summaries | `mem:summaries` |
| `mem:config` | Runtime configuration | `mem:config` |
| `mem:metrics` | Performance metrics | `mem:metrics` |
| `mem:health` | Health check state | `mem:health` |
| `mem:emb:<obsId>` | Observation embeddings | `mem:emb:obs_abc123` |
| `mem:index:bm25` | BM25 search index | `mem:index:bm25` |
| `mem:relations` | Entity relations | `mem:relations` |
| `mem:profiles` | Project profiles | `mem:profiles` |
| `mem:claude-bridge` | MEMORY.md sync state | `mem:claude-bridge` |
| `mem:graph:nodes` | Knowledge graph nodes | `mem:graph:nodes` |
| `mem:graph:edges` | Knowledge graph edges | `mem:graph:edges` |
| `mem:semantic` | Semantic tier memories | `mem:semantic` |
| `mem:procedural` | Procedural tier memories | `mem:procedural` |
| `mem:team:*` | Team shared memory | `mem:team:team123:shared` |
| `mem:audit` | Audit log entries | `mem:audit` |
| `mem:actions` | Action items | `mem:actions` |
| `mem:action-edges` | Action dependencies | `mem:action-edges` |
| `mem:leases` | Active leases | `mem:leases` |
| `mem:routines` | Workflow routines | `mem:routines` |
| `mem:signals` | Inter-agent signals | `mem:signals` |
| `mem:checkpoints` | External checkpoints | `mem:checkpoints` |
| `mem:mesh` | Mesh sync state | `mem:mesh` |
| `mem:sketches` | Ephemeral action graphs | `mem:sketches` |
| `mem:facets` | Facet dimension tags | `mem:facets` |
| `mem:sentinels` | Event watchers | `mem:sentinels` |
| `mem:crystals` | Crystalized action chains | `mem:crystals` |
| `mem:lessons` | Learned lessons | `mem:lessons` |
| `mem:insights` | Synthesized insights | `mem:insights` |
| `mem:slots` | Memory slots | `mem:slots` |
| `mem:slots:global` | Global memory slots | `mem:slots:global` |
| `mem:state` | Runtime state | `mem:state` |
| `mem:commits` | Commit linkages | `mem:commits` |

### 5.3 Core Data Types (from `src/types.ts`)

**Session:**
```typescript
interface Session {
  id: string;           // "sess_" + timestamp + random
  project: string;      // project path or name
  cwd: string;          // working directory
  startedAt: string;    // ISO timestamp
  endedAt?: string;     // ISO timestamp
  status: "active" | "completed" | "abandoned";
  observationCount: number;
  model?: string;
  tags?: string[];
  firstPrompt?: string;
  summary?: string;
  commitShas?: string[];
  agentId?: string;
}
```

**RawObservation:**
```typescript
interface RawObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  hookType: HookType;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  userPrompt?: string;
  assistantResponse?: string;
  raw: unknown;
  modality?: "text" | "image" | "mixed";
  imageData?: string;
  agentId?: string;
}
```

**CompressedObservation:**
```typescript
interface CompressedObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  type: ObservationType;           // file_read, file_write, command_run, decision, etc.
  title: string;
  subtitle?: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files: string[];
  importance: number;              // 0-1 scoring
  confidence?: number;
  imageRef?: string;
  modality?: "text" | "image" | "mixed";
  agentId?: string;
}
```

**Memory:**
```typescript
interface Memory {
  id: string;
  content: string;       // main memory text
  concepts: string[];    // key concepts
  tags: string[];
  project: string;
  type: MemoryType;      // pattern, preference, architecture, bug, workflow, fact
  confidence: number;    // 0-1, decays over time
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
  sourceObservationIds: string[];
  supersedes?: string[]; // versioning chain
  agentId?: string;
}
```

### 5.4 ID Generation

Two ID strategies:

- **`generateId(prefix)`** — Unique, non-deterministic ID: `"{prefix}_{base36-timestamp}_{12-random-chars}"`
  - Used for: sessions, observations, actions, leases, signals, and any new entity
- **`fingerprintId(prefix, content)`** — Content-addressable ID (SHA-256 hash prefix): `"{prefix}_{16-hex-chars}"`
  - Used for: deduplication, memory identification, consolidating repeated content

### 5.5 Search Indexes

Three parallel indexes for the triple-stream search:

1. **BM25 Index** (`src/state/search-index.ts`)
   - Token frequency + document frequency scoring
   - Synonym expansion via `src/state/synonyms.ts`
   - CJK segmentation via optional `@node-rs/jieba` / `tiny-segmenter`
   - Stemmed via `src/state/stemmer.ts`
   - Persisted in `mem:index:bm25`

2. **Vector Index** (`src/state/vector-index.ts`)
   - In-memory FAISS-like flat index
   - Cosine similarity search
   - Sharded persistence for large indices
   - Multiple embedding provider support (local via @xenova/transformers, OpenAI, Voyage, Cohere, Gemini, OpenRouter)

3. **Knowledge Graph** (`src/functions/graph.ts` + `graph-retrieval.ts`)
   - Entity extraction from observations (LLM-powered)
   - Nodes (`mem:graph:nodes`) and edges (`mem:graph:edges`) stored as KV pairs
   - BFS traversal for graph-aware retrieval
   - Temporal edge history tracking

### 5.6 Fusion Algorithm

The three streams are combined via **Reciprocal Rank Fusion** (RRF, k=60):

```
score(d) = BM25_RRF(d) + VECTOR_RRF(d) + GRAPH_RRF(d)

where RRF_score(d) = 1 / (k + rank(d))
```

Results are session-diversified (max 3 results per session) and optionally cross-encoder reranked.

---

## 6. API Design

### 6.1 REST API

126 endpoints on port 3111, all under the `/agentmemory/` prefix. The REST API binds to `127.0.0.1` by default. Protected endpoints require `Authorization: Bearer <secret>` when `AGENTMEMORY_SECRET` is set.

**Key Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/agentmemory/health` | Health check (always public) |
| `GET` | `/agentmemory/livez` | Liveness probe |
| `POST` | `/agentmemory/session/start` | Start a new session + get context |
| `POST` | `/agentmemory/session/end` | End an active session |
| `POST` | `/agentmemory/observe` | Submit an observation |
| `POST` | `/agentmemory/smart-search` | Hybrid semantic+keyword search |
| `POST` | `/agentmemory/context` | Generate context for agent |
| `POST` | `/agentmemory/remember` | Save to long-term memory |
| `POST` | `/agentmemory/forget` | Delete observations or sessions |
| `POST` | `/agentmemory/compress` | Compress an observation |
| `POST` | `/agentmemory/enrich` | Enrich file context |
| `GET` | `/agentmemory/profile` | Get project profile |
| `GET` | `/agentmemory/export` | Export all memory data |
| `POST` | `/agentmemory/import` | Import from JSON |
| `POST` | `/agentmemory/graph/query` | Knowledge graph traversal |
| `POST` | `/agentmemory/team/share` | Share with team members |
| `GET` | `/agentmemory/team/feed` | Recent team shared items |
| `GET` | `/agentmemory/audit` | Audit trail of operations |
| `POST` | `/agentmemory/mcp/tools` | MCP tool call (via REST transport) |
| `GET` | `/agentmemory/viewer` | Viewer SPA HTML |
| `POST` | `/agentmemory/memories` | List/create memories |
| `GET` | `/agentmemory/memories/:id` | Get memory details |
| `POST` | `/agentmemory/observations` | List observations |
| `POST` | `/agentmemory/sessions` | List sessions |
| `POST` | `/agentmemory/actions` | CRUD for action items |
| `POST` | `/agentmemory/leases` | Acquire/release leases |
| `POST` | `/agentmemory/signals` | Send/receive signals |
| `POST` | `/agentmemory/checkpoints` | Create/resolve checkpoints |
| `POST` | `/agentmemory/mesh/sync` | P2P mesh sync |
| `POST` | `/agentmemory/consolidate` | Run manual consolidation |
| `POST` | `/agentmemory/reflect` | Run slot reflection |
| `POST` | `/agentmemory/slots` | CRUD memory slots |
| `POST` | `/agentmemory/snapshots` | Create/list snapshots |
| `POST` | `/agentmemory/diagnostics` | Run health diagnostics |
| `POST` | `/agentmemory/smart-search/followup-rate` | Follow-up rate diagnostic |

**Auth pattern:**
```typescript
function checkAuth(req: ApiRequest, secret: string | undefined): Response | null {
  if (!secret) return null;
  const auth = req.headers?.["authorization"] || req.headers?.["Authorization"];
  if (typeof auth !== "string" || !timingSafeCompare(auth, `Bearer ${secret}`)) {
    return { status_code: 401, body: { error: "unauthorized" } };
  }
  return null;
}
```

**Endpoint registration pattern:**
```typescript
sdk.registerFunction("api::my-endpoint", async (req: ApiRequest) => {
  const denied = checkAuth(req, secret);
  if (denied) return denied;
  // validate + whitelist fields
  const result = await sdk.trigger({ function_id: "mem::my-func", payload: { ... } });
  return { status_code: 200, body: result };
});
sdk.registerTrigger({
  type: "http",
  function_id: "api::my-endpoint",
  config: { api_path: "/agentmemory/my-path", http_method: "POST" },
});
```

### 6.2 MCP Server

53 MCP tools exposed via the `mcp::tools::list` and `mcp::tools::call` functions (registered as HTTP endpoints at `/agentmemory/mcp/tools`).

**Core tools (always visible, 8):** memory_recall, memory_compress_file, memory_save, memory_smart_search, memory_file_history, memory_sessions, memory_timeline, memory_profile

**Extended tools (visible with `AGENTMEMORY_TOOLS=all`, 53 total):** All core tools plus memory_patterns, memory_relations, memory_graph_query, memory_consolidate, memory_claude_bridge_sync, memory_team_share, memory_team_feed, memory_audit, memory_governance_delete, memory_snapshot_create, memory_action_create, memory_action_update, memory_frontier, memory_next, memory_lease, memory_routine_run, memory_signal_send, memory_signal_read, memory_checkpoint, memory_mesh_sync, memory_sentinel_create, memory_sentinel_trigger, memory_sketch_create, memory_sketch_promote, memory_crystallize, memory_diagnose, memory_heal, memory_facet_tag, memory_facet_query, memory_verify, memory_export, and more.

**MCP resources (6):** `agentmemory://status`, `agentmemory://project/{name}/profile`, `agentmemory://memories/latest`, `agentmemory://graph/stats`

**MCP prompts (3):** `recall_context`, `session_handoff`, `detect_patterns`

### 6.3 iii Functions

50+ functions internally registered, named with a two-part prefix convention:

| Prefix | Domain | Examples |
|--------|--------|---------|
| `mem::` | Core memory operations | `mem::observe`, `mem::remember`, `mem::compress`, `mem::forget`, `mem::smart-search` |
| `api::` | REST endpoint handlers | `api::session-start`, `api::observe`, `api::smart-search` |
| `mcp::` | MCP tool handlers | `mcp::tools::list`, `mcp::tools::call` |

### 6.4 Streams

- **`mem-live`** stream on `:3112` — real-time observation feed
- Grouped by session ID via `STREAM.group(sessionId)`
- Viewer consumes the `viewer` group for live dashboard updates

---

## 7. Integration with KodeHold

### 7.1 Adoption Model

Agentmemory is a **KodeHold-adopted project** (not KodeHold-created). It was forked from `rohitg00/agentmemory` v0.9.25 and lives at `/home/kiffer/project/agentmemory` with KodeHold-specific patches applied.

The KodeHold workspace at `workspaces/agentmemory/` is a git worktree/symlink into the agentmemory project. The `.kodehold-state` file at the agentmemory root tracks KodeHold lifecycle: `ADOPTED=true`, `STATE=INIT`.

### 7.2 KodeHold Fork Patches

Our `kodehold` branch applies two patches to the built dist files (not TypeScript source — patching is done post-build in `dist/`):

| Patch | File | Change | Purpose |
|-------|------|--------|---------|
| Viewer bind address | `dist/src-*.mjs` | Default viewer host `127.0.0.1` → `0.0.0.0` via `AGENTMEMORY_VIEWER_HOST` env | Allows remote access to the viewer in containerized/local-network setups |
| Security bypass | `dist/src-*.mjs` | `if (!isLoopbackHost(host))` → `if (false)` | Bypasses the AGENTMEMORY_SECRET requirement for non-loopback viewer binds in our internal deployment |

**Patch file location:** `/home/kiffer/project/kodehold/patches/agentmemory-viewer-bind-0.9.25.patch`

These patches are applied to the **dist files** (`src-*.mjs`), NOT to the TypeScript source. The bundler (`tsdown`) generates a single entry chunk (e.g., `src-B8J9Exum.mjs`) that the CLI entry point (`dist/cli.mjs`) imports at runtime. The `index.mjs` is dead code in the current build — both files must be patched for the change to survive across rebuilds.

### 7.3 KodeHold-Specific Config

| Setting | Value | Where |
|---------|-------|-------|
| `AGENTMEMORY_VIEWER_HOST` | `0.0.0.0` | Controlled by env var |
| Viewer security block | Disabled (`if(false)`) | Patch file |

### 7.4 Development Workflow

```
# Source code lives in:
/home/kiffer/project/agentmemory/src/

# Build produces:
/home/kiffer/project/agentmemory/dist/

# Patches stored in (KodeHold project):
/home/kiffer/project/kodehold/patches/

# Workspace config:
/home/kiffer/project/kodehold/workspaces/agentmemory/
```

---

## 8. Testing Strategy

### 8.1 Test Framework

- **vitest** v4.1.6 — the sole test framework
- TypeScript source tested directly (no build step needed)
- Coverage: 950+ tests

### 8.2 Test Organization

All tests live in `test/` as flat `.test.ts` files:

| Category | Count (approx) | Examples |
|----------|----------------|---------|
| Core memory operations | ~80 | `remember-bm25-index.test.ts`, `remember-forget-audit.test.ts` |
| Search & retrieval | ~60 | `smart-search.test.ts`, `hybrid-search.test.ts`, `search.test.ts`, `search-index.test.ts` |
| MCP tools | ~50 | `mcp-standalone.test.ts`, `mcp-standalone-proxy.test.ts`, `mcp-prompts.test.ts`, `mcp-resources.test.ts`, `mcp-transport.test.ts` |
| Viewer | ~30 | `viewer-graph-cooldown.test.ts`, `viewer-host.test.ts`, `viewer-security.test.ts`, `viewer-session-id.test.ts` |
| Consolidation | ~40 | `consolidation-default.test.ts`, `consolidation-pipeline.test.ts`, `consolidate-project-scope.test.ts` |
| Graph | ~30 | `graph.test.ts`, `graph-retrieval.test.ts`, `temporal-graph.test.ts` |
| Slots & context | ~25 | `slots.test.ts`, `context-slots.test.ts`, `context-injection.test.ts`, `context-lessons.test.ts` |
| Auth & security | ~15 | `viewer-security.test.ts`, `privacy.test.ts` |
| CLI | ~30 | `cli-connect.test.ts`, `cli-onboarding.test.ts`, `cli-remove.test.ts` |
| Integration | ~10 | `integration.test.ts`, `integration-plaintext-http.test.ts` |
| Export/import | ~20 | `export-import.test.ts`, `snapshot.test.ts` |
| Coordination | ~40 | `actions.test.ts`, `leases.test.ts`, `signals.test.ts`, `routines.test.ts`, `sentinels.test.ts` |
| Other | ~500+ | `audit.test.ts`, `cascade.test.ts`, `crystallize.test.ts`, `diagnostics.test.ts`, `facets.test.ts`, `frontier.test.ts`, `lessons.test.ts`, `mesh.test.ts`, `reflect.test.ts`, `verify.test.ts`, etc. |

### 8.3 Mock Pattern

The standard mock pattern uses `vi.mock` for the `iii-sdk` module:

```typescript
import { vi } from "vitest";

// Mock the iii-sdk at module level
vi.mock("iii-sdk", () => ({
  registerWorker: vi.fn().mockReturnValue({
    registerFunction: vi.fn(),
    registerTrigger: vi.fn(),
    trigger: vi.fn(),
  }),
}));

// In each test, access the mock SDK:
const mockSdk = (registerWorker as jest.Mock).mock.results[0].value;
mockSdk.trigger.mockResolvedValue({ success: true });
```

### 8.4 Test Run Modes

| Command | Scope |
|---------|-------|
| `npm test` | All tests EXCEPT integration (`test/integration.test.ts`) |
| `npm run test:watch` | Watch mode, no integration tests |
| `npm run test:integration` | Integration tests only |
| `npm run test:all` | Full suite including integration |

### 8.5 State Management for Tests

- Viewer/security tests set env vars per-test (no module-level caching for host/port resolution)
- Mock KV is an in-memory `Map` for unit tests
- Integration tests require a running iii-engine instance

### 8.6 Fixtures

`test/fixtures/` contains sample data (sessions, observations, graph data) used across multiple test files.

---

## 9. Token Optimization Strategy

agentmemory is designed to minimize token consumption in agent conversations. This is a core architectural concern, not an afterthought.

### 9.1 Token Budget

Default budget: **2,000 tokens** per context injection (configurable via `TOKEN_BUDGET` env var). At ~1,900 tokens/session, agentmemory consumes ~$10/year in LLM tokens vs ~$500 for LLM-summarized alternatives and ~$infinity for pasting full context.

### 9.2 Retrieval Efficiency

- **Triple-stream search** ensures only the most relevant observations are retrieved
- **Top-K only** — never loads all data into context
- **RRF fusion** prevents any single stream from dominating
- **Session diversification** (max 3 results/session) avoids repetitive context

### 9.3 Observation Size Control

- Raw observations are stored immediately but **compressed asynchronously** by the LLM
- Privacy filter runs before storage, stripping API keys, secrets, `<private>` tags
- Image data stored as references (`imageRef`), not inline base64 (unless explicitly captured)

### 9.4 Compression Pipeline

- **PostToolUse** → raw observation → dedup → privacy filter → store raw → LLM compress (if enabled)
- Compression output: `{ title, subtitle, facts: string[], concepts: string[], narrative: string, importance: number }`
- Synthetic BM25-only compression works when no LLM is configured (no token cost)

### 9.5 Decay and Eviction

- Memories decay via Ebbinghaus curve (configurable decay rate)
- Frequently accessed memories strengthen (reinforcement)
- Stale memories auto-evict (TTL-based + importance threshold)
- Retention scores track access patterns

### 9.6 KodeHold-Specific Note

This project is a KodeHold workspace; token optimization strategies are managed at the KodeHold framework level. No additional project-specific token optimizations are applied beyond those described above.

---

## 10. File Layout

```
/home/kiffer/project/agentmemory/
├── AGENTS.md              # Agent instructions (8 consistency rules, code patterns)
├── DESIGN.md              # Visual design system (Lamborghini-themed UI)
├── README.md              # Upstream documentation
├── CHANGELOG.md           # Release notes
├── package.json           # Dependencies, scripts, version
├── tsconfig.json          # TypeScript config
├── tsdown.config.ts       # Build config (tsdown bundler)
├── .env.example           # Environment variable template
├── docker-compose.yml     # Docker Compose for iii-engine
├── iii-config.yaml        # iii engine configuration
├── iii-config.docker.yaml # Docker-specific engine config
│
├── src/
│   ├── index.ts           # Main entry: registers all functions + triggers + viewer
│   ├── cli.ts             # CLI entry: start, stop, connect, doctor, demo, etc.
│   ├── config.ts          # Environment/config loading
│   ├── version.ts         # VERSION constant
│   ├── types.ts           # All TypeScript interfaces (~911 lines)
│   ├── auth.ts            # HMAC authentication, CSP headers
│   ├── logger.ts          # Logging utilities
│   ├── xenova.d.ts        # Type declarations for @xenova/transformers
│   │
│   ├── cli/               # CLI sub-modules
│   │   ├── doctor-diagnostics.ts
│   │   ├── remove-plan.ts
│   │   ├── splash.ts
│   │   ├── onboarding.ts
│   │   └── preferences.ts
│   │
│   ├── state/             # State/persistence layer
│   │   ├── kv.ts          # StateKV wrapper around iii-sdk (get/set/update/delete/list)
│   │   ├── schema.ts      # KV scopes, generateId, fingerprintId, jaccardSimilarity
│   │   ├── search-index.ts      # BM25 keyword search
│   │   ├── vector-index.ts      # In-memory vector embeddings
│   │   ├── hybrid-search.ts     # BM25 + Vector + Graph fusion
│   │   ├── index-persistence.ts # Index save/load
│   │   ├── reranker.ts          # Cross-encoder reranking
│   │   ├── keyed-mutex.ts       # Per-key async locks
│   │   ├── stemmer.ts           # Word stemming
│   │   ├── synonyms.ts          # Synonym expansion
│   │   ├── cjk-segmenter.ts     # CJK text segmentation
│   │   └── memory-utils.ts      # Memory display formatting
│   │
│   ├── functions/         # 64 iii function registration modules
│   │   ├── observe.ts, remember.ts, forget.ts, evict.ts
│   │   ├── compress.ts, compress-file.ts, compress-synthetic.ts
│   │   ├── search.ts, smart-search.ts
│   │   ├── context.ts, enrich.ts, profile.ts
│   │   ├── consolidate.ts, consolidation-pipeline.ts
│   │   ├── crystallize.ts, reflect.ts
│   │   ├── graph.ts, graph-retrieval.ts, temporal-graph.ts
│   │   ├── actions.ts, leases.ts, signals.ts, routines.ts
│   │   ├── checkpoints.ts, frontier.ts, sentinels.ts, sketches.ts
│   │   ├── mesh.ts, team.ts
│   │   ├── patterns.ts, lessons.ts, facets.ts, verify.ts, cascade.ts
│   │   ├── export-import.ts, snapshot.ts, claude-bridge.ts
│   │   ├── obsidian-export.ts, migrate.ts
│   │   ├── privacy.ts, dedup.ts
│   │   ├── slots.ts, working-memory.ts, skill-extract.ts
│   │   ├── replay.ts, sliding-window.ts
│   │   ├── summarize.ts, query-expansion.ts
│   │   ├── diagnostics.ts, file-index.ts
│   │   ├── vision-search.ts, image-refs.ts, image-quota-cleanup.ts
│   │   ├── branch-aware.ts, flow-compress.ts, retention.ts
│   │   ├── recent-searches-sweep.ts, disk-size-manager.ts
│   │   └── auto-forget.ts, access-tracker.ts
│   │
│   ├── mcp/               # MCP server implementation
│   │   ├── tools-registry.ts    # 53 tool definitions + getVisibleTools()
│   │   ├── server.ts            # MCP HTTP handlers (mcp::tools::list + mcp::tools::call)
│   │   ├── standalone.ts        # MCP standalone mode (stdio)
│   │   ├── rest-proxy.ts        # REST proxy for standalone MCP
│   │   ├── in-memory-kv.ts      # In-memory KV for standalone MCP
│   │   └── transport.ts         # MCP transport layer
│   │
│   ├── providers/         # LLM provider system
│   │   ├── index.ts            # Provider factory
│   │   ├── noop.ts             # Default no-op provider
│   │   ├── anthropic.ts        # Anthropic API
│   │   ├── openai.ts           # OpenAI API
│   │   ├── openrouter.ts       # OpenRouter API
│   │   ├── minimax.ts          # MiniMax API
│   │   ├── agent-sdk.ts        # Claude subscription fallback
│   │   ├── resilient.ts        # Circuit-breaker wrapper
│   │   ├── fallback-chain.ts   # Provider fallback ordering
│   │   ├── circuit-breaker.ts  # Circuit breaker pattern
│   │   ├── _fetch.ts           # HTTP fetch utilities
│   │   ├── _openai-shared.ts   # Shared OpenAI logic
│   │   └── embedding/          # Embedding providers
│   │
│   ├── triggers/          # HTTP and event trigger registration
│   │   ├── api.ts            # 126 REST endpoint registrations (~3,120 LOC)
│   │   └── events.ts         # Event trigger setup
│   │
│   ├── hooks/             # Agent lifecycle hook scripts
│   │   ├── session-start.ts, session-end.ts
│   │   ├── post-tool-use.ts, post-tool-failure.ts
│   │   ├── pre-tool-use.ts, pre-compact.ts
│   │   ├── prompt-submit.ts, notification.ts
│   │   ├── stop.ts, subagent-start.ts, subagent-stop.ts
│   │   ├── task-completed.ts, post-commit.ts
│   │   ├── _project.ts, sdk-guard.ts
│   │
│   ├── viewer/            # Real-time viewer server
│   │   ├── server.ts          # HTTP server, proxy, CORS, CSP, auth
│   │   ├── document.ts        # SPA shell rendering
│   │   ├── index.html         # Viewer SPA application
│   │   └── favicon.svg        # Viewer favicon
│   │
│   ├── health/            # Health monitoring
│   │   ├── monitor.ts         # Health check logic
│   │   └── thresholds.ts      # Health thresholds
│   │
│   ├── telemetry/         # OTEL telemetry
│   │   └── setup.ts
│   │
│   ├── prompts/           # MCP prompt templates
│   │
│   └── utils/             # General utilities
│
├── test/                  # 128 test files (~950+ tests)
│   ├── helpers/           # Test helper utilities
│   ├── fixtures/          # Test fixture data
│   └── *.test.ts          # Flat test files
│
├── plugin/                # Agent plugins (Claude, Codex, OpenCode, etc.)
│   ├── .claude-plugin/    # Claude Code plugin
│   ├── .codex-plugin/     # Codex CLI plugin
│   ├── opencode/          # OpenCode plugin (22 hooks)
│   ├── hooks/             # Hook shell scripts
│   ├── skills/            # 8 SKILL.md files
│   ├── scripts/           # Utility scripts
│   ├── .mcp.json          # MCP server config for Claude
│   ├── .mcp.copilot.json  # MCP server config for Copilot
│   └── plugin.json        # Plugin manifest
│
├── deploy/                # One-click deploy templates
│   ├── fly/               # fly.io deployment
│   ├── railway/           # Railway deployment
│   ├── render/            # Render deployment
│   └── coolify/           # Coolify self-hosted deployment
│
├── docs/                  # Documentation
│   ├── design/README.md   # THIS DOCUMENT (KodeHold retroactive design)
│   ├── adr/               # ADR storage
│   ├── benchmarks/        # Benchmark reports
│   └── recipes/           # Integration recipes
│
├── integrations/          # Agent-specific integrations
│   ├── openclaw/
│   ├── hermes/
│   ├── pi/
│   └── ...
│
├── benchmark/             # Benchmarking
├── eval/                  # Evaluation harness (LongMemEval, coding-life)
├── examples/              # Usage examples
└── assets/                # Images, demo gifs
```

---

## 11. Implementation Plan

**Not applicable.** This project is already fully implemented (v0.9.25, 950+ tests, production-ready). This design document is a retroactive description of the existing codebase for KodeHold adoption purposes.

Future feature additions should follow the standard KodeHold lifecycle:

1. Create ADR for the proposed change
2. Update this design doc
3. Implement (Engineers)
4. Test (Testers)
5. Review (Reviewers)
6. Close

---

## ADR Index

The following Architectural Decision Records exist for this project:

| ADR | Title | Status |
|-----|-------|--------|
| ADR-0001 | Viewer Loopback Relaxation | Accepted | 2026-06-03 |
| ADR-0002 | Viewer Security Bypass for Local Development | Accepted | 2026-06-03 |

2 ADRs accepted (ADR-0001, ADR-0002).

---

## Open Questions

1. **Patch management strategy:** Should KodeHold maintain patches as stand-alone `.patch` files (current approach) or as a proper fork branch with CI that rebuilds the dist files? (See ADR-0001)
2. **ADR coverage:** Which upstream design decisions warrant retroactive ADRs? Candidates include: iii-engine primitive choice, KV-over-SQLite persistence, 4-tier consolidation, triple-stream search architecture, HMAC auth model, hook-as-subprocess architecture, MCP dual-mode design.
3. **Version upgrade process:** How should KodeHold handle upstream version bumps (e.g., v0.10.0)? Rebase fork, re-apply patches, or lock to current version?
4. **Minor per-project config:** The workspace's `/home/kiffer/project/agentmemory` path is hardcoded in workspace config — should it be parametrized?
5. **Source vs dist patching:** Current patches target dist files. Should KodeHold patch TypeScript source instead and run its own build?

---

## Changelog

- 2026-06-03: Adopted by KodeHold — design doc created retroactively (all 11 sections filled)
  - Purpose & Scope — defined agentmemory's role as persistent memory server for AI coding agents
  - Requirements — documented runtime requirements (Node 20+, iii-engine v0.11.2), all dependencies, ports, env vars
  - Architecture Overview — described iii-engine primitives, memory pipeline, 4-tier consolidation, port map, code statistics
  - Component Design — catalogued all 12+ subsystems: state layer, core functions, auth, viewer, hooks, plugins, providers, config, CLI, health, telemetry
  - Data Model — documented KV store architecture, 34+ KV scopes, core data types, ID generation, search indexes, fusion algorithm
  - API Design — documented 126 REST endpoints, 53 MCP tools, 6 resources, 3 prompts, iii function naming convention, streams
  - Integration — documented KodeHold adoption model, 2 fork patches, workspace layout
  - Testing Strategy — documented vitest framework, 950+ tests, mock patterns, test organization
  - Token Optimization Strategy — documented token budget, retrieval efficiency, compression pipeline, decay/eviction
  - File Layout — complete project tree with descriptions for every directory
  - Implementation Plan — marked as "Already implemented, retroactive design"
  - ADR Index — noted 2 ADRs pending
  - Open Questions — captured 5 open questions for future resolution
