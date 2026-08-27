# MiniCode

<p align="center">
  <img src="./docs/logo.svg" alt="MiniCode Logo" width="180" />
</p>

<h2 align="center">MiniCode</h2>

<p align="center">
  <img src="https://img.shields.io/badge/Editor-Minicode-D97757?style=for-the-badge" alt="Editor: Minicode" />
  <img src="https://img.shields.io/badge/%23minicode-Project-B85C3F?style=for-the-badge" alt="#minicode" />
  <img src="https://img.shields.io/badge/%23lightweight-Focus-F0EBE1?style=for-the-badge&labelColor=8B8B8B" alt="#lightweight" />
  <a href="https://deepwiki.com/LiuMengxuan04/MiniCode">
    <img src="https://img.shields.io/badge/Ask-DeepWiki-0F7BBF?style=for-the-badge&labelColor=2B2B2B" alt="Ask DeepWiki" />
  </a>
</p>

---

<p align="center">
  A lightweight, highly efficient coding tool. Designed for speed, built for simplicity.
</p>

[简体中文](./README.zh-CN.md) | [Usage Guide](./USAGE.md) | [DeepWiki](https://deepwiki.com/LiuMengxuan04/MiniCode) | [Architecture](./ARCHITECTURE.md) | [Contributing](./CONTRIBUTING.md) | [Roadmap](./ROADMAP.md) | [License](./LICENSE)

MiniCode is a lightweight terminal coding assistant for local development workflows.

It provides Claude Code-like workflow and architectural ideas in a much smaller implementation, making it especially useful for learning, experimentation, and custom tooling.

## Overview

MiniCode is built around a practical terminal-first agent loop:

- accept a user request
- inspect the workspace
- call tools when needed
- review file changes before writing
- return a final response in the same terminal session

The project is intentionally compact, so the control flow, tool model, and TUI behavior remain easy to understand and extend.

## Core Authors

<table>
  <tr>
    <td align="center" valign="top" width="20%">
      <a href="https://github.com/LiuMengxuan04">
        <img src="https://github.com/LiuMengxuan04.png?size=160" width="96" height="96" alt="LiuMengxuan04" /><br />
        <strong>Liu Mengxuan</strong>
      </a>
      <br />
      <sub><strong>Founder</strong></sub>
      <br />
      <sub>Leads the TypeScript repo, core workflow, MCP/Skills, TUI, and docs.</sub>
    </td>
    <td align="center" valign="top" width="20%">
      <a href="https://github.com/GateJustice">
        <img src="https://github.com/GateJustice.png?size=160" width="96" height="96" alt="GateJustice" /><br />
        <strong>GateJustice</strong>
      </a>
      <br />
      <sub><strong>Co-initiator</strong></sub>
      <br />
      <sub>Contributes the long-session context system, including usage accounting, auto compact, and context collapse.</sub>
    </td>
    <td align="center" valign="top" width="20%">
      <a href="https://github.com/harkerhand">
        <img src="https://github.com/harkerhand.png?size=160" width="96" height="96" alt="harkerhand" /><br />
        <strong>harkerhand</strong>
      </a>
      <br />
      <sub><strong>MiniCode-rs</strong></sub>
      <br />
      <sub>Main author of the Rust version.</sub>
    </td>
    <td align="center" valign="top" width="20%">
      <a href="https://github.com/QUSETIONS">
        <img src="https://github.com/QUSETIONS.png?size=160" width="96" height="96" alt="QUSETIONS" /><br />
        <strong>QUSETIONS</strong>
      </a>
      <br />
      <sub><strong>MiniCode-Python</strong></sub>
      <br />
      <sub>Main author of the Python version.</sub>
    </td>
    <td align="center" valign="top" width="20%">
      <a href="https://github.com/GoDiao">
        <img src="https://github.com/GoDiao.png?size=160" width="96" height="96" alt="GoDiao" /><br />
        <strong>GoDiao</strong>
      </a>
      <br />
      <sub><strong>Core contributor</strong></sub>
      <br />
      <sub>Contributes layered memory, /init, session resume, and TUI interaction improvements.</sub>
    </td>
  </tr>
</table>

Summaries are based on the main repository and multi-language branch commit history. For the broader contributor list, please refer to the repository commit history.

## Multi-language Versions

- TypeScript (this repo): [MiniCode](https://github.com/LiuMengxuan04/MiniCode)
- Rust version: [MiniCode-rs](https://github.com/harkerhand/MiniCode-rs/tree/master)
- Python version: [MiniCode-Python](https://github.com/QUSETIONS/MiniCode-Python)
- Go version: [MiniCode-go](https://github.com/ssbsunshengbo/MiniCode)
- Java version: [MiniCode4j](https://github.com/hobbescalvin414-tech/minicode4j/tree/feat/default-ts-ui)

## Product Showcase Page

- Open [docs/index.html](./docs/index.html) in a browser for a visual product overview.
- GitHub Pages (recommended): `https://liumengxuan04.github.io/MiniCode/`

## Why MiniCode

MiniCode is a good fit if you want:

- a lightweight coding assistant instead of a large platform
- a terminal UI with tool calling, transcript, and command workflow
- a small codebase that is suitable for study and modification
- a reference implementation for Claude Code-like agent architecture

## Core Capabilities

- Multi-step tool execution in a single turn, forming a `model -> tool -> model` loop.
- Full-screen terminal UI with input history, transcript scrolling, slash command menu, and approval flows.
- Per-project session persistence with resume, rename, fork, and compact commands.
- Provider-usage-first context stats with tail estimates, auto-compact, context collapse, and snip compact.
- Built-in tools for files, search, editing, command execution, web fetch/search, and clarification prompts.
- Local skills discovered through `SKILL.md`, plus MCP tools/resources/prompts over stdio or remote HTTP.
- Review-before-write file edits with path and command permission checks.
- Oversized tool results are stored on disk and replaced in context with a short preview and file path.

## Incremental Add-ons: Long-Term Memory, Trace & LLM-as-Judge

This repo ships three additive modules on top of the core agent loop. They are
**disabled by default** — enable each one explicitly in `~/.mini-code/settings.json`.
All new configuration is validated with Zod without changing the original
settings loading logic, and none of the existing features (microcompact,
auto-compact, transcript persistence, MCP, tool calls) are modified.

The vector store is **ChromaDB** (replacing the former FAISS dependency, which
is fully removed): a single Chroma instance persists both long-term memories
and business-document chunks under `~/.mini-code/chroma/`, with the `memory`
and `knowledge` collections strictly isolated. Chroma and embedding failures
are caught, written to the trace log, and degrade to BM25-only retrieval — the
agent session keeps running.

### 1. Long-Term Memory (RAG)

Short-term memory stays in the LLM message context, untouched. A separate
long-term memory store persists important facts into a local vector store and
recalls them with **BM25 + vector hybrid retrieval** (fused weights) at the
start of each new turn, injecting the recalled memories into the agent context.

- **Session memory** (`scope=session`) is isolated per project under
  `~/.mini-code/memory/projects/<project-slug>/session.jsonl`.
- **Global memory** (`scope=global`) is shared across projects under
  `~/.mini-code/memory/global.jsonl`.
- At the end of each turn (`extractOnTurnEnd`) the agent auto-extracts task
  outcomes, file changes, and error lessons into memory (duplicates skipped).
- **Lifecycle**: entries age `active → dormant → archived`, then expired
  archived entries are garbage-collected. `active` memories are injected into
  context; `dormant` ones are searchable but no longer auto-injected;
  `archived` ones need explicit lifecycle tooling. Retrieval touches update
  `lastAccessedAt`/`accessCount`, and over-capacity scopes evict the
  oldest-accessed non-active entries. Run GC on startup (`gcOnStartup`) and
  manually with `/memory-ltm gc` or `memory.gc()`.
- **Update & merge**: `memory_update` (replace/append, re-embeds and
  reactivates) and `memory_merge` (combine 2-10 entries into one, sources
  removed, provenance in `metadata.mergedFrom`).
- **Local file knowledge base**: configure `knowledgeBase.path` (external
  business-document RAG, default off) or `knowledgeBase.dirs` (back-compat) to
  auto-import directories of **`.md` / `.txt`** business documents on startup
  (or rebuild manually with the `/index` slash command). Source-code files are
  intentionally **not** indexed — they stay on the existing `read_file` tool.
  Documents are split by the built-in markdown-aware chunker (headings →
  paragraphs → overlapping windows), vectorized through the shared embedding
  function, and stored as `kb`-scope entries with source-path metadata in the
  Chroma `knowledge` collection. Re-imports are idempotent (old chunks are
  replaced).
- **Vector store: ChromaDB**. All vector persistence goes through a single
  Chroma instance under `~/.mini-code/chroma/` with two strictly isolated
  collections: `knowledge` (business-doc chunks, `~/.mini-code/chroma/knowledge/`)
  and `memory` (long-term memories, `~/.mini-code/chroma/memory/`). When
  `memory.chroma.url` (default `http://127.0.0.1:8000`) is reachable the real
  Chroma REST API is used; otherwise a Chroma-semantics-compatible persistent
  store (float32 binary + JSONL metadata) serves the same collection API
  offline. Chroma init failures degrade to BM25-only retrieval and never break
  the agent turn.
- Retrieval pipeline: **BM25 keyword recall (local in-memory) + Chroma vector
  recall → RRF reciprocal-rank fusion → reranker → top-N**. RRF
  (`score = Σ 1/(k+rank)`, `k = memory.rrfK`, default 60) merges the two
  ranked channels without score normalization. The reranker re-scores fused
  candidates with query-term coverage and length features (offline by
  default); an OpenAI-style `/v1/rerank` API reranker is supported via config.
- Embedding defaults to the OpenAI-compatible **`qwen3.7-text-embedding`**
  model. Configure `embedding.baseUrl` + `embedding.apiKey` (and optionally
  `embedding.model`). All embedding calls go through one shared `embedTexts`
  function; failures are caught, recorded in the trace log, and degrade the
  RAG/memory modules to BM25-only retrieval without interrupting the agent
  session. `embedding.provider: "local"` keeps the offline hash
  bag-of-words fallback.

Config (`~/.mini-code/settings.json`):

```jsonc
{
  "memory": {
    "enabled": true,                  // opt-in
    "topK": 5,
    "injectEveryTurn": true,
    "maxInjectChars": 4000,
    "extractOnTurnEnd": true,
    "defaultScope": "session",        // "session" | "global"
    "maxEntriesPerScope": 500,
    "rrfK": 60,                       // RRF rank constant (1/(k+rank))
    "bm25Weight": 0.5,               // kept for back-compat; RRF ignores weights
    "vectorWeight": 0.5,
    "embedding": {
      "provider": "api",             // api (default, qwen) | local (offline hash)
      "model": "qwen3.7-text-embedding",
      "baseUrl": "https://<your-openai-compatible-host>",
      "apiKey": ""
    },
    "chroma": {
      "url": "http://127.0.0.1:8000", // Chroma server; unreachable → local persistent store
      "timeoutMs": 5000
    },
    "reranker": {
      "enabled": true,
      "provider": "local",        // local | api
      "topN": 20,
      "model": "",                // required for provider=api
      "baseUrl": "",              // required for provider=api
      "apiKey": ""
    },
    "lifecycle": {
      "agingDays": 30,             // active → dormant
      "archiveDays": 90,           // dormant → archived
      "retentionDays": 180,        // archived → deleted (GC)
      "capacityEviction": true,    // evict oldest non-active over cap
      "gcOnStartup": true          // run GC when mini-code starts
    },
    "knowledgeBase": {
      "path": "docs",              // business-doc folder (.md/.txt only) → enables RAG KB; default off
      "dirs": ["docs"],            // back-compat alias for startup auto-load
      "extensions": [".md", ".txt"],
      "ignoreDirs": [".git", "node_modules", "dist", "build", ".mini-code"],
      "maxCharsPerChunk": 1200,     // chunk_size (chars)
      "chunkOverlap": 120           // chunk_overlap (chars)
    }
  }
}
```

Tools (inputs and outputs validated with Zod): `memory_add`, `memory_search`,
`memory_delete`, `memory_list`, `memory_update` (replace/append), `memory_merge`,
`kb_import`, and `knowledge_retrieve` (hybrid BM25 + Chroma vector retrieval with
RRF fusion and reranking, returning top-N document chunks with source paths).
Command:
`/memory-ltm list | rm <id> | gc`, plus knowledge-base management under
`/memory-ltm kb <list|scan <dir>|import <dir> [name]|remove <name>|clear>`.
Knowledge-base entries are stored at `~/.mini-code/memory/projects/<slug>/kb.jsonl`
(metadata) and their vectors in the Chroma `knowledge` collection.

Business-document knowledge base (`.md`/`.txt` only) is enabled by setting
`memory.knowledgeBase.path`; the index is built/loaded at startup and can be
rebuilt manually at any time:

- **`/index`** — in-TUI slash command that re-scans the configured folder,
  re-chunks, re-embeds and re-imports all chunks into the Chroma `knowledge`
  collection (idempotent; old chunks of the same source are replaced). There is
  **no file-watcher** — after editing your docs, run `/index` to refresh.
- **Startup auto-load**: `knowledgeBase.path` (or back-compat `knowledgeBase.dirs`)
  folders are imported on every launch (idempotent).
- **CLI**: `minicode kb scan <dir>` (preview), `minicode kb import <dir>
  [--name <name>] [--max-chars <n>] [--overlap <n>]`, `minicode kb list`,
  `minicode kb remove <name>`, `minicode kb clear`.
- **Agent tool**: the model can call `knowledge_retrieve` at any time to query
  the business-doc knowledge base.

### 2. Trace Tracking

Every agent turn is recorded as one JSON line (trace) capturing the full
pipeline: user input, LLM request payload, tool calls and returns,
microcompact/auto-compact/snip/context-collapse events, RAG retrieval results,
reranked output, memory injection content, token stats, and per-stage
durations. Model requests are captured by wrapping the existing `ModelAdapter`
— the agent loop itself is never modified.

Config: `{ "trace": { "enabled": true, "maxFileEntries": 2000 } }`

Files: `~/.mini-code/traces/<project-slug>/traces.jsonl` (one JSON object per
line: `traceId`, `timestamp`, stage timings, inputs/outputs).

Command: `/trace [n]` shows summaries of the current session's recent traces.

### 3. LLM-as-Judge Rubric Evaluation

Evaluate the agent output with a judge LLM against a multi-criteria rubric
(prompt + optional reference answer + rubric dimensions). The judge reuses the
existing `AnthropicModelAdapter` (no duplicated LLM request code); its JSON
output is constrained by a Zod schema, with one automatic retry on invalid
output.

Config: `{ "judge": { "enabled": true, "maxScore": 5, "reference": "", "model": "" } }`

Command: `/evaluate` scores the latest turn, appends the result to the trace
log, and writes a full report to
`~/.mini-code/reports/evaluate-<timestamp>-<traceId>.json`.

Full command references, configuration examples, session details, and Skills/MCP usage have moved to the [Usage Guide](./USAGE.md).

## Installation

```bash
cd mini-code
npm install
npm run install-local
```

The installer asks for the model name, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN`. Configuration is stored in:

- `~/.mini-code/settings.json`
- `~/.mini-code/mcp.json`

You can override the config directory with `MINI_CODE_HOME` and the launcher directory with `MINI_CODE_BIN_DIR`. See [Installation Details](./USAGE.md#installation-details) for more.

## Quick Start

Run the installed launcher:

```bash
minicode
```

Run in development mode:

```bash
npm run dev
```

Run in offline demo mode:

```bash
MINI_CODE_MODEL_MODE=mock npm run dev
```

## Common Entry Points

- `/help`: show interactive help.
- `/tools`: list available tools.
- `/skills`: list discovered skills.
- `/mcp`: show MCP connection status.
- `/status`: show session and context status.
- `/init`: scaffold `.mini-code/` and `MINI.md` for the current project.
- `/memory`: inspect the layered memory files loaded for the current turn.
- `/model` / `/model <name>`: inspect or switch the model.
- `/resume`: open the session picker.
- `/compact`: manually compact the context.

Management commands include `minicode mcp ...` and `minicode skills ...`. See [Commands](./USAGE.md#commands) for the full reference.

## Documentation

- [Usage Guide](./USAGE.md)
- [Architecture Overview](./ARCHITECTURE.md)
- [中文架构说明](./ARCHITECTURE_ZH.md)
- [Contribution Guidelines](./CONTRIBUTING.md)
- [中文贡献规范](./CONTRIBUTING_ZH.md)
- [Roadmap](./ROADMAP.md)
- [路线图](./ROADMAP_ZH.md)
- [Learn Claude Code Design Through MiniCode](./CLAUDE_CODE_PATTERNS.md)

## Star History

<a href="https://www.star-history.com/?repos=LiuMengxuan04%2FMiniCode&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=LiuMengxuan04/MiniCode&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=LiuMengxuan04/MiniCode&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=LiuMengxuan04/MiniCode&type=date&legend=bottom-right" />
 </picture>
</a>

## Development

```bash
npm run check
npm test
```

MiniCode is intentionally small and pragmatic. The goal is to keep the architecture understandable, hackable, and easy to extend.
