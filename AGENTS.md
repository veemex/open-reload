# AGENTS.md — open-reload

## What This Is

Self-reloading MCP meta-plugin for OpenCode. Watches plugin source files and its own brain, re-imports on change, serves tools via MCP stdio. No restart required for brain or plugin changes.

## Architecture: Shell / Brain Split

```
src/shell/   → PERMANENT. Never reloads. Touches stdio pipe.
src/brain/   → HOT-RELOADABLE. All interesting logic. Auto-reloads on file change.
```

### Shell (src/shell/) — ~200 lines total

| File | Role |
|------|------|
| `brain-api.ts` | Stable contract types. Brain implements these. |
| `brain-loader.ts` | Purge Bun module cache + import + atomic swap |
| `watch-driver.ts` | fs.watch() with debounce |
| `core-tools.ts` | `openreload_reload` + `openreload_status` (always work) |
| `mcp.ts` | McpServer + StdioServerTransport + dynamic tool sync |
| `main.ts` | Process entry. Start MCP → load brain → start watcher → signals |

### Brain (src/brain/) — hot-swappable

| File | Role |
|------|------|
| `entry.ts` | BrainFactory.create() → BrainAPI. Wires all subsystems. |
| `config/loader.ts` | Config resolution: explicit → `.opencode/` → `~/.config/` |
| `config/types.ts` | PluginConfig, PluginState, ManagedTool, OpenReloadConfig |
| `loader/module-loader.ts` | Cache-bust import + tool extraction (3 export formats) |
| `router/tool-router.ts` | qualifiedName → ManagedTool.execute() routing |
| `state/plugin-state.ts` | Per-plugin lifecycle tracking + BrainSnapshot serialization |
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

No functions, no class instances, no circular refs. `PluginStateManager.toSnapshot()` strips execute functions. If you add state that must survive brain reload, it goes in the snapshot.

### 6. No type suppression

No `as any`, `@ts-ignore`, `@ts-expect-error`. Fix the types properly.

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
- Core tools: registered once, permanently
- Brain tools: dynamically registered/unregistered via `RegisteredTool.remove()` + `registerTool()` on each `syncBrainTools()` call
- `sendToolListChanged()` fires after every tool sync so clients re-fetch

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
| `opencode-plugin` | `export default async (input) => ({ tool: { name: { description, args, execute } } })` | Any `@opencode-ai/plugin` |
| `tool-array` | `export const tools = [{ name, description, inputSchema, execute }]` | Simple tool list |
| `mcp-tools` | `export const tools = { name: { description, inputSchema, execute } }` | Tool map |

### opencode-plugin format details

This is the native `@opencode-ai/plugin` format used by OpenCode plugins:

- Plugin function is **async** and receives a stub `{ directory, worktree }` input
- Return property is `tool` (singular). Falls back to `tools` for compatibility.
- `args` is a **Zod raw shape** (e.g. `{ name: z.string() }`). Converted to JSON Schema via `z.toJSONSchema()`.
- `execute(args, context)` — context is a stub `ToolContext` with no-op `ask()` and `metadata()`.
- If Zod version mismatch prevents schema conversion, falls back to generic `{ type: "object" }`.
- `ask()` calls log a warning to stderr — user interaction not supported in open-reload context.

### tool-array / mcp-tools formats

- `execute` signature: `(input: Record<string, unknown>) => Promise<string>`
- `inputSchema` is plain JSON Schema (not Zod)

Tool names are qualified as `pluginName_toolName` to prevent collisions.

## Testing

```bash
bun test          # 84 tests across 8 files
bun test <file>   # run specific test file
```

- Framework: `bun:test` (NOT jest)
- Integration tests use `InMemoryTransport` from MCP SDK to test client↔server without stdio
- Watch-driver tests use temp directories with `mkdtempSync`
- Brain-loader tests run against the real brain (which loads mock plugin from `.opencode/open-reload.json`)

## Dev Setup

- Mock plugin: `dev/mock-plugin/index.ts` (3 tools: echo, add, upcase)
- Mock opencode-plugin: `dev/mock-opencode-plugin/index.ts` (2 tools: greet, multiply)
- Dev config: `.opencode/open-reload.json` points to both mock plugins
- Run: `bun run dev` or `bun run src/shell/main.ts`

## Startup Sequence

```
1. main() creates BrainContext
2. startMcpServer() → McpServer + core tools + connect transport
3. reload() → swapBrain() → brain loads config → loads plugins → builds router
4. syncBrainTools() → register brain tools with McpServer → sendToolListChanged
5. syncPluginWatchers() → start FileWatcher per plugin watchDir root
6. FileWatcher on src/brain/** → triggers reload() on change
7. FileWatcher on plugin dirs → brain.onFileEvents() → selective plugin reload → syncBrainTools
8. SIGINT/SIGTERM → stop all watchers → dispose brain → close MCP → exit
```

## Key Gotcha: Tool List Timing

After startup, there's a brief window where only core tools are available (brain hasn't loaded yet). Once `reload()` completes, `syncBrainTools()` registers plugin tools and sends `tools/list_changed`. Clients must re-fetch after receiving the notification.

## File Structure

```
src/
  index.ts                          # barrel exports
  shell/                            # PERMANENT
    brain-api.ts                    # stable contract types
    brain-loader.ts                 # purge + import + atomic swap
    watch-driver.ts                 # fs.watch orchestration
    core-tools.ts                   # escape-hatch tools
    mcp.ts                          # McpServer + stdio + dynamic tool sync
    main.ts                         # process entry + lifecycle
  brain/                            # HOT-RELOADABLE
    entry.ts                        # BrainFactory → BrainAPI
    config/
      types.ts                      # PluginConfig, PluginState, ManagedTool
      loader.ts                     # config resolution + validation
    loader/
      module-loader.ts              # cache-bust import + tool extraction
    router/
      tool-router.ts                # qualifiedName → execute routing
    state/
      plugin-state.ts               # per-plugin state + snapshot
    watcher/
      policy.ts                     # WatchPlan + event classification
tests/
  core-tools.test.ts                # core tool specs + status formatting
  brain-loader.test.ts              # brain load + swap + error recovery
  mcp-integration.test.ts           # client↔server via InMemoryTransport
  watch-driver.test.ts              # file watching + debounce + filtering
  tool-router.test.ts               # routing + rebuild + error wrapping
  plugin-state.test.ts              # lifecycle + snapshot + restore
  watch-policy.test.ts              # WatchPlan + event classification
  module-loader.test.ts             # plugin loading (all 3 formats) + Zod→JSON Schema + cache busting
dev/
  mock-plugin/
    index.ts                        # 3 tools (echo, add, upcase)
  mock-opencode-plugin/
    index.ts                        # 2 tools (greet, multiply) in opencode-plugin format
.opencode/
  open-reload.json                  # dev config → both mock plugins
```
