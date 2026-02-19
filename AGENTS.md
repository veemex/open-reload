# AGENTS.md — open-reload

## What This Is

Self-reloading MCP meta-plugin for OpenCode. Watches plugin source files and its own brain, re-imports on change, serves tools, resources, and prompts via MCP stdio. No restart required for brain or plugin changes. Supports plugin composition (dependencies, namespaces, agent visibility), event-driven inter-plugin communication, and persistent state.

## Architecture: Shell / Brain Split

```
src/shell/   → PERMANENT. Never reloads. Touches stdio pipe.
src/brain/   → HOT-RELOADABLE. All interesting logic. Auto-reloads on file change.
```

### Shell (src/shell/) — ~200 lines total

| File | Role |
|------|------|
| `brain-api.ts` | Stable contract types: BrainAPI, ToolCallContext, ResourceSpec, PromptSpec, PromptMessage, ResourceContent |
| `brain-loader.ts` | Purge Bun module cache + import + atomic swap |
| `watch-driver.ts` | fs.watch() with debounce |
| `core-tools.ts` | `openreload_reload` + `openreload_status` (always work) |
| `mcp.ts` | McpServer + StdioServerTransport + dynamic tool/resource/prompt sync + getCwd callback |
| `main.ts` | Process entry. Start MCP → load brain → start watcher → signals |

### Brain (src/brain/) — hot-swappable

| File | Role |
|------|------|
| `entry.ts` | BrainFactory.create() → BrainAPI. Topological sort, event bus creation, plugin loading, dispose, persistent state. |
| `config/loader.ts` | Config resolution: explicit → `.opencode/` → `~/.config/`. Validates dependsOn, namespace, agentVisibility, systemPrompts, statePath. |
| `config/types.ts` | PluginConfig, PluginState, ManagedTool, ManagedResource, ManagedPrompt, PluginLoadResult, OpenReloadConfig, SystemPromptConfig |
| `events/event-bus.ts` | PluginEventBus — per-plugin handler tracking for cleanup on reload |
| `loader/module-loader.ts` | Cache-bust import + tool/resource/prompt extraction (3 export formats). Dynamic context construction with ToolCallContext + event bus injection. |
| `router/tool-router.ts` | qualifiedName → ManagedTool.execute() routing with namespace/agentVisibility filtering |
| `state/plugin-state.ts` | Per-plugin lifecycle tracking + resource/prompt aggregation + BrainSnapshot serialization |
| `watcher/policy.ts` | WatchPlan from config + FileEvent classification |

## Hard Rules — NEVER Violate

### 1. Shell NEVER imports from src/brain/

The contract lives in `src/shell/brain-api.ts`. Shell talks to brain only through the `BrainAPI` interface. If you add an import from `src/brain/` in any shell file, you break hot-reload.

### 2. Brain reload is atomic

New brain succeeds completely OR old brain stays. Never leave the system in a half-reloaded state. See `swapBrain()` in `brain-loader.ts`.

### 3. Core tools ALWAYS work

`openreload_reload` and `openreload_status` are registered in the shell, not the brain. They must function even when brain is null, broken, or mid-reload.

### 4. Shell self-watch is hardcoded

The watcher on `src/brain/**` is in the shell. It triggers reload WITHOUT consulting the brain. Brain's `getWatchPlan()` is for plugin directories only.

### 5. BrainSnapshot must be JSON-serializable

No functions, no class instances, no circular refs. `PluginStateManager.toSnapshot()` strips execute functions. If you add state that must survive brain reload, it goes in the snapshot. `zodInputSchema` is NOT included in snapshots.

### 6. No type suppression

No `as any`, `@ts-ignore`, `@ts-expect-error`. Fix the types properly.

### 7. Event bus handlers are NOT in snapshots

The `PluginEventBus` is recreated on each brain load. Plugin handlers are re-registered during plugin loading, not restored from snapshots.

## When Changes Require Hard Restart

| Changed | Restart needed? |
|---------|----------------|
| `src/shell/**` | YES — hard restart |
| `src/brain/**` | NO — auto hot-reload via self-watcher |
| `dev/mock-plugin/**` | NO — auto hot-reload (once plugin watchers wired) |
| `package.json` / deps | YES — hard restart |
| `.opencode/open-reload.json` | Currently YES — config hot-reload is Phase 4 |

## MCP Server Details

- Uses `McpServer` (high-level SDK API), NOT the low-level `Server` class
- Transport: `StdioServerTransport` in production, injectable `Transport` for tests
- Capabilities: `tools` (listChanged), `resources` (listChanged), `prompts` (listChanged)
- Core tools: registered once, permanently
- Brain tools: dynamically registered/unregistered via `RegisteredTool.remove()` + `registerTool()` on each `syncBrainTools()` call
- Brain resources: dynamically synced via `syncBrainResources()` — calls `brain.listResources()` + `brain.readResource()`
- Brain prompts: dynamically synced via `syncBrainPrompts()` — calls `brain.listPrompts()` + `brain.getPrompt()`
- `sendToolListChanged()`, `sendResourceListChanged()`, `sendPromptListChanged()` fire after every sync so clients re-fetch
- `getCwd` callback on `startMcpServer` opts provides updateable CWD forwarding to tool context

## ToolCallContext

Shell constructs `ToolCallContext` and passes it through `ToolCall.context` to brain's `callTool()`:

```typescript
type ToolCallContext = {
  cwd: string;           // from getCwd() callback
  sessionId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
};
```

Brain's `ToolRouter.route()` passes context to `ManagedTool.execute(args, context)`. For opencode-plugin format, context is mapped to a rich `execContext` with `directory`, `worktree`, `sessionID`, `agent`, `abort`, `metadata()`, `ask()`, and `events`.

## Plugin Event Bus

`PluginEventBus` enables inter-plugin communication:

```typescript
type PluginEvent = { source: string; type: string; payload: unknown; timestamp: number };
```

- `on(eventType, handler, pluginName?)` — subscribe, returns unsubscribe function
- `emit(event)` — async dispatch to all handlers for that type, errors swallowed
- `removePlugin(pluginName)` — removes all handlers registered by a plugin (called on plugin reload)
- `clear()` — removes all handlers (called on brain dispose)

Per-plugin handler tracking ensures clean teardown. Event bus is injected into opencode-plugin format's `execContext.events`.

## MCP Resources & Prompts

### Resources

Plugins return `resource` map from opencode-plugin format:
```typescript
{ resource: { "uri": { description?, mimeType?, read: () => Promise<string> } } }
```
Aggregated by `PluginStateManager.getAllResources()`. Brain's `listResources()` and `readResource()` delegate to managed resources.

### Prompts

Plugins return `prompt` map from opencode-plugin format:
```typescript
{ prompt: { "name": { description?, arguments?, get: (args?) => Promise<PromptMessage[]> } } }
```
System prompts from config (`systemPrompts` array) are served alongside plugin prompts. System prompt names are prefixed with `system:`. Sorted by priority (higher = earlier).

## Plugin Composition

### Dependencies (`dependsOn`)

Plugins declare dependencies via `dependsOn: string[]` in config. Entry.ts uses `topoSort()` (Kahn's algorithm) to determine load order. Missing dependencies and circular dependencies throw errors.

On file change, `getReloadOrder()` cascades: if plugin A depends on plugin B, changing B reloads both B and A (in topological order).

### Namespaces (`namespace`)

Each plugin can declare a `namespace` string. `ToolRouter.listSpecs(filter?)` can filter by namespace — tools with a namespace that doesn't match the filter are excluded.

### Agent Visibility (`agentVisibility`)

Each plugin can declare `agentVisibility: string[]`. `ToolRouter.listSpecs(filter?)` can filter by `agentId` — tools with a visibility list that doesn't include the requesting agent are excluded.

### Prefix Control (`prefix`)

`prefix: false` in config disables the `pluginName_` prefix on tool names.

## Persistent State

When `statePath` is set in config:
- On `brain.dispose()`: snapshot is saved to disk via atomic write (tmp file + rename)
- On `brain.create()`: if no in-memory snapshot exists, attempts to load from `statePath`
- Crash-safe: uses `writeFileSync(tmpPath)` + `renameSync(tmpPath, statePath)`

## CLI Arguments

```bash
bun run src/shell/main.ts                          # auto-discover config
bun run src/shell/main.ts --config /path/to/cfg.json  # explicit config
```

Config resolution: `--config` flag → `.opencode/open-reload.json` → `~/.config/open-reload/open-reload.json`.

## Plugin Export Formats

Three supported formats in `module-loader.ts`:

| exportType | Shape | Example |
|-----------|-------|---------|
| `opencode-plugin` | `export default async (input) => ({ tool: { ... }, resource?: { ... }, prompt?: { ... }, dispose?: () => Promise<void> })` | Any `@opencode-ai/plugin` |
| `tool-array` | `export const tools = [{ name, description, inputSchema, execute }]` | Simple tool list |
| `mcp-tools` | `export const tools = { name: { description, inputSchema, execute } }` | Tool map |

### opencode-plugin format details

This is the native `@opencode-ai/plugin` format used by OpenCode plugins:

- Plugin function is **async** and receives a `{ directory, worktree }` input (constructed dynamically from `process.cwd()`)
- Return property is `tool` (singular). Falls back to `tools` for compatibility.
- Optional return properties: `resource` (map), `prompt` (map), `dispose` (async function)
- `args` is a **Zod raw shape** (e.g. `{ name: z.string() }`). Converted to JSON Schema via `z.toJSONSchema()`.
- `execute(args, context)` — context includes `sessionID`, `agent`, `directory`, `worktree`, `abort`, `metadata()`, `ask()`, and `events` (event bus bridge).
- `events.emit(type, payload)` and `events.on(type, handler)` bridge to the PluginEventBus.
- If Zod version mismatch prevents schema conversion, falls back to generic `{ type: "object" }`.
- `ask()` calls log a warning to stderr — user interaction not supported in open-reload context.
- `zodInputSchema` is stored as `unknown` in shell types to avoid shell→Zod dependency.

### tool-array / mcp-tools formats

- `execute` signature: `(input: Record<string, unknown>, context?: ToolCallContext) => Promise<string>`
- `inputSchema` is plain JSON Schema (not Zod). Converted to Zod via `z.fromJSONSchema()` for MCP registration.
- Resources, prompts, and dispose are NOT supported in these formats (tools only).

Tool names are qualified as `pluginName_toolName` to prevent collisions (unless `prefix: false`).

## PluginLoadResult

The return type from `loadPluginModule()`:

```typescript
interface PluginLoadResult {
  tools: ManagedTool[];
  resources?: ManagedResource[];
  prompts?: ManagedPrompt[];
  dispose?: () => Promise<void>;
}
```

`PluginStateManager.setLoaded()` accepts all fields. Resources and prompts are aggregated alongside tools.

## Testing

```bash
bun test          # 158 tests across 22 files
bun test <file>   # run specific test file
```

- Framework: `bun:test` (NOT jest)
- Integration tests use `InMemoryTransport` from MCP SDK to test client↔server without stdio
- Watch-driver tests use temp directories with `mkdtempSync`
- Brain-loader tests run against the real brain (which loads mock plugin from `.opencode/open-reload.json`)

## Dev Setup

- Mock plugin: `dev/mock-plugin/index.ts` (3 tools: echo, add, upcase)
- Mock opencode-plugin: `dev/mock-opencode-plugin/index.ts` (2 tools: greet, multiply)
- Mock worktree-plugin: `dev/mock-worktree-plugin/index.ts` (worktree-aware plugin for reload tests)
- Dev config: `.opencode/open-reload.json` points to mock plugins
- Run: `bun run dev` or `bun run src/shell/main.ts`

## Startup Sequence

```
1. main() creates BrainContext
2. startMcpServer() → McpServer + core tools + connect transport (with getCwd callback)
3. reload() → swapBrain() → brain loads config → topoSort plugins → loads plugins (with event bus) → builds router
4. syncBrainTools() → register brain tools with McpServer → sendToolListChanged
5. syncBrainResources() → register brain resources with McpServer → sendResourceListChanged
6. syncBrainPrompts() → register brain prompts with McpServer → sendPromptListChanged
7. syncPluginWatchers() → start FileWatcher per plugin watchDir root
8. FileWatcher on src/brain/** → triggers reload() on change
9. FileWatcher on plugin dirs → brain.onFileEvents() → selective plugin reload (with cascade) → syncBrainTools/Resources/Prompts
10. SIGINT/SIGTERM → stop all watchers → dispose brain (saves persistent state) → close MCP → exit
```

## Key Gotcha: Tool List Timing

After startup, there's a brief window where only core tools are available (brain hasn't loaded yet). Once `reload()` completes, `syncBrainTools()` registers plugin tools and sends `tools/list_changed`. Clients must re-fetch after receiving the notification. Same applies to resources and prompts.

## File Structure

```
src/
  index.ts                          # barrel exports
  shell/                            # PERMANENT
    brain-api.ts                    # stable contract types (ToolCallContext, ResourceSpec, PromptSpec, PromptMessage, ResourceContent)
    brain-loader.ts                 # purge + import + atomic swap
    watch-driver.ts                 # fs.watch orchestration
    core-tools.ts                   # escape-hatch tools
    mcp.ts                          # McpServer + stdio + dynamic tool/resource/prompt sync + getCwd
    main.ts                         # process entry + lifecycle
  brain/                            # HOT-RELOADABLE
    entry.ts                        # BrainFactory → BrainAPI + topoSort + persistent state + event bus wiring
    config/
      types.ts                      # PluginConfig, PluginState, ManagedTool, ManagedResource, ManagedPrompt, PluginLoadResult, SystemPromptConfig
      loader.ts                     # config resolution + validation (dependsOn, namespace, agentVisibility, systemPrompts, statePath)
    events/
      event-bus.ts                  # PluginEventBus — per-plugin handler tracking, emit/on/removePlugin/clear
    loader/
      module-loader.ts              # cache-bust import + tool/resource/prompt extraction + event bus injection
    router/
      tool-router.ts                # qualifiedName → execute routing + namespace/agentVisibility filtering
    state/
      plugin-state.ts               # per-plugin state + resource/prompt aggregation + snapshot
    watcher/
      policy.ts                     # WatchPlan + event classification
tests/
  brain-loader.test.ts              # brain load + swap + error recovery
  context-threading.test.ts         # ToolCallContext threading through call chain
  core-tools.test.ts                # core tool specs + status formatting
  cwd-forwarding.test.ts            # getCwd callback forwarding to tool context
  event-bus.test.ts                 # PluginEventBus: emit, on, removePlugin, per-plugin tracking
  integration/
    e2e.test.ts                     # end-to-end brain + MCP integration
  mcp-integration.test.ts           # client↔server via InMemoryTransport
  mcp-prompts.test.ts               # MCP prompt sync + getPrompt
  mcp-resources.test.ts             # MCP resource sync + readResource
  module-loader.test.ts             # plugin loading (all 3 formats) + Zod→JSON Schema + cache busting + resource/prompt extraction
  namespace-routing.test.ts         # namespace + agentVisibility filtering in ToolRouter
  persistent-state.test.ts          # statePath save/load + atomic write + crash recovery
  plugin-deps.test.ts               # dependsOn validation + topological sort + cascade reload
  plugin-dispose.test.ts            # dispose lifecycle: plugin reload + brain dispose
  plugin-state.test.ts              # lifecycle + snapshot + restore + resource/prompt tracking
  schema-passthrough.test.ts        # zodInputSchema passthrough (stored as unknown, not serialized)
  schema-roundtrip.test.ts          # Zod ↔ JSON Schema conversion round-trip
  system-prompts.test.ts            # system prompt config + priority sorting + resolution
  tool-router.test.ts               # routing + rebuild + error wrapping + filtering
  watch-driver.test.ts              # file watching + debounce + filtering
  watch-policy.test.ts              # WatchPlan + event classification
  worktree-reload.test.ts           # worktree-aware plugin loading + path resolution
dev/
  mock-plugin/
    index.ts                        # 3 tools (echo, add, upcase)
  mock-opencode-plugin/
    index.ts                        # 2 tools (greet, multiply) in opencode-plugin format
  mock-worktree-plugin/
    index.ts                        # worktree-aware plugin for reload tests
.opencode/
  open-reload.json                  # dev config → mock plugins
```
