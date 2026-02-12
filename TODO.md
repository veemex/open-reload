# open-reload — Implementation Roadmap

> **Design priority**: Self-reloadability. open-reload must be able to improve itself at runtime.
> The shell/brain split is the foundational architecture — see RESEARCH.md for details.

## Phase 0: Shell (Never Reloads)

The shell is the permanent skeleton. Every line here is a line that can't be improved without restart. Keep it minimal.

- [ ] **P0-1**: `src/shell/brain-api.ts` — The stable contract
  - Define `BrainAPI`, `BrainFactory`, `ToolSpec`, `ToolCall`, `ToolResult`
  - Define `WatchPlan`, `FileEvent`, `BrainSnapshot`, `BrainContext`
  - Plain objects only — no classes, no imports from brain
  - This file changes ~never. Any change requires process restart.

- [ ] **P0-2**: `src/shell/brain-loader.ts` — Brain swapper
  - `purge(brainDir)`: walk `src/brain/**`, delete each from `Loader.registry`
  - `load(entryPath)`: cache-bust import, call `factory.create(ctx, init)`
  - `swap(oldBrain, newBrain)`: snapshot old → create new → dispose old → return new
  - On failure: keep old brain, log error to stderr, return old brain
  - Unit tests: load, swap, error recovery (bad brain keeps old alive)

- [ ] **P0-3**: `src/shell/watch-driver.ts` — Filesystem watcher orchestration
  - Owns all `fs.watch()` handles and debounce timers
  - Hardcoded self-watch: `src/brain/**` changes → trigger `reloadBrain()` directly (no brain consultation)
  - Dynamic plugin watch: runs according to `brain.getWatchPlan()`
  - Forwards debounced events to `brain.onFileEvents()`, executes returned effects
  - Refreshes watch plan when brain says `{ refreshWatchPlan: true }`

- [ ] **P0-4**: `src/shell/mcp.ts` — MCP server with stdio transport
  - `@modelcontextprotocol/sdk` Server on stdio
  - `tools/list` handler: shell core tools + `activeBrain.listTools()`
  - `tools/call` handler: intercept `openreload_reload` / `openreload_status` (shell-owned), else delegate to `activeBrain.callTool()`
  - Send `notifications/tools/list_changed` when brain swap changes tool list

- [ ] **P0-5**: `src/shell/core-tools.ts` — Shell-owned escape hatches
  - `openreload_reload`: force brain reload even if brain is broken
  - `openreload_status`: report brain version, last reload time, last error, loaded plugins
  - These always work, regardless of brain state

- [ ] **P0-6**: `src/shell/main.ts` — Process entry
  - Parse CLI args (config path)
  - Create MCP server + stdio transport
  - Load initial brain
  - Start watchers
  - Wire signals (SIGINT/SIGTERM → graceful shutdown)

## Phase 1: Brain (Hot-Reloadable)

Everything interesting lives here. Can be improved by an AI agent at runtime without restarting.

- [ ] **P1-1**: `src/brain/entry.ts` — Brain factory
  - Default export: `BrainFactory` with `create(ctx, init) → BrainAPI`
  - Restores state from `init.snapshot` if present (reload continuity)
  - Initializes all subsystems: config, plugins, router

- [ ] **P1-2**: `src/brain/config/` — Config loading
  - Move existing `loader.ts` + `types.ts` into `src/brain/config/`
  - Config resolution: explicit path → local → global
  - Validation with descriptive errors

- [ ] **P1-3**: `src/brain/loader/module-loader.ts` — Plugin module loading
  - Move existing cache-busting loader into brain
  - Purge plugin module graph before re-import
  - Extract tools based on `exportType` (opencode-plugin, tool-array, mcp-tools)
  - Last-known-good: on import failure, keep previous plugin tools active

- [ ] **P1-4**: `src/brain/router/tool-router.ts` — Tool routing
  - Map qualified tool names (`pluginName_toolName`) to plugin execute functions
  - Rebuild routing table on plugin reload
  - Handle unknown tool calls gracefully

- [ ] **P1-5**: `src/brain/watcher/policy.ts` — Watch policy
  - Produce `WatchPlan` from loaded config (which plugin dirs to watch)
  - Classify `FileEvent[]` → effects: reload specific plugin, reload brain, refresh plan
  - Ignore patterns from config (node_modules, .git, tests)

- [ ] **P1-6**: `src/brain/state/plugin-state.ts` — Plugin state management
  - Track per-plugin: loaded tools, last reload time, status, error
  - Serialize to `BrainSnapshot` for reload continuity
  - Restore from snapshot on brain reload

## Phase 2: Integration & Self-Reload Testing

- [ ] **P2-1**: End-to-end self-reload test
  - Start server → modify brain source → verify brain reloads → verify tools still work
  - Modify brain with syntax error → verify old brain stays active
  - Fix syntax error → verify recovery

- [ ] **P2-2**: End-to-end plugin reload test
  - Start server with plugin → modify plugin → verify tool list changes → verify new tool works
  - Add new tool to plugin → verify `tools/list_changed` notification sent

- [ ] **P2-3**: Graceful tool execution during reload
  - Tool call arrives during brain reload → served from last-known-good or queued
  - No partial state (tool list from plugin A + stale plugin B)

- [ ] **P2-4**: Module graph purge verification
  - Change `src/brain/config/types.ts` → verify brain picks up new types on reload
  - Change nested dependency → verify full graph invalidation

## Phase 3: Developer Experience

- [ ] **P3-1**: Structured logging
  - JSON log to file (configurable path)
  - Log levels: error, warn, info, debug
  - Events: brain reload, plugin reload, tool diff, errors, tool calls

- [ ] **P3-2**: Brain meta-tools (brain-owned, hot-reloadable)
  - `openreload_plugins`: list all managed plugins, their state, tool counts
  - `openreload_config`: show current resolved configuration
  - `openreload_force_plugin_reload`: manually trigger reload of a specific plugin

- [ ] **P3-3**: CLI interface
  - `open-reload start [--config path]` — starts the MCP server
  - `open-reload status` — shows brain + plugin states (via MCP introspection)

## Phase 4: Advanced

- [ ] **P4-1**: Config hot-reload
  - Watch the config file itself
  - Add/remove plugins at runtime without restart
  - Brain responds with `{ refreshWatchPlan: true }` to pick up new plugin dirs

- [ ] **P4-2**: Snapshot persistence
  - Write `BrainSnapshot` to disk periodically
  - On process restart: restore from persisted snapshot for faster cold start

- [ ] **P4-3**: Performance profiling
  - Measure reload latency (target: < 500ms from file save to `tools/list_changed`)
  - Profile memory growth over many reloads
  - Implement module instance cap if needed

## Architecture Invariants (Never Violate)

1. Shell **never** imports from `src/brain/`. The `BrainAPI` contract lives in shell.
2. Brain reload must invalidate the **entire** `src/brain/**` module graph, not just `entry.ts`.
3. Brain reload is **atomic**: new brain succeeds completely or old brain stays.
4. `openreload_reload` tool **always works**, even if brain is in error state.
5. Shell self-watch (`src/brain/**`) triggers reload **without consulting brain**.
6. All brain state that must survive reload goes into `BrainSnapshot` (JSON-serializable).

## Out of Scope (for now)

- **Native plugin hot-reload** — requires patching OpenCode upstream
- **Cross-machine reload** — MCP over network transport
- **GUI** — CLI + MCP tools only
- **Plugin marketplace** — discovery/installation of plugins
