# Hot-Reload Research Findings

Research conducted during the `opencodingbox` session. Three parallel research agents investigated Bun module caching, OpenCode plugin internals, and MCP protocol capabilities.

## Problem Statement

OpenCode plugins are loaded once at startup via `import()`. Changing plugin code requires restarting the entire OpenCode process. For rapid plugin development, this is a significant friction point.

**Goal**: Enable runtime hot-reload of plugin tools without restarting OpenCode.

## Finding 1: Bun Module Cache Busting

Bun caches modules by their resolved path. To force re-import:

```typescript
// 1. Delete from Bun's internal registry
Loader.registry.delete(absolutePath);

// 2. Re-import with cache-busting query string
const freshModule = await import(absolutePath + "?t=" + Date.now());
```

**Key details:**
- `Loader.registry` is Bun's internal module cache (undocumented but stable)
- Query string trick (`?t=timestamp`) forces a fresh evaluation even if the path resolves to the same file
- Works for both `.ts` and `.js` files — Bun transpiles TypeScript natively
- Side effects in the module (top-level code) will re-execute on each reload

**Risk**: `Loader.registry` is not a public API. May break across Bun versions. Fallback: spawn a child process for each reload.

## Finding 2: OpenCode Plugin Internals

### Native Plugin Loading (snapshotted)

```
OpenCode startup
  → Instance.state() 
    → pluginInit() 
      → import(pluginPath) 
        → plugin.tools → Tool[] 
          → snapshotted into State.custom[]
```

- Plugin tools are **cached permanently** in `Instance.state().custom[]`
- No mechanism to refresh them at runtime
- `State.dispose()` clears all state — nuclear option, not selective

### MCP Tool Loading (always fresh)

```
Every tool invocation
  → MCP.tools() 
    → client.listTools() 
      → fresh tool list from server
```

- MCP tools are **never cached** — fetched from the server on every `tools()` call
- This means an MCP server can add, remove, or modify tools at any time
- OpenCode already handles `notifications/tools/list_changed` — triggers a re-fetch

**Critical insight**: MCP is inherently hot-reloadable. Native plugins are not.

## Finding 3: MCP Protocol Support

The MCP spec natively supports dynamic tool changes:

```
Server → Client: notifications/tools/list_changed
Client: re-calls tools/list → gets updated tool list
```

OpenCode's MCP client (`packages/opencode/src/mcp/index.ts`) already subscribes to `ToolListChangedNotification` and handles it by refreshing the tool list.

**This means**: If we build an MCP server that watches plugin files and sends `tools/list_changed` on change, OpenCode will pick up new tools automatically. Zero upstream changes needed.

## Winning Architecture

**MCP meta-server** that:

1. **Watches** plugin source files for changes (via `Bun.watch()` or `fs.watch()`)
2. **Re-imports** plugin modules using cache busting on file change
3. **Extracts** tool definitions from the freshly loaded module
4. **Serves** tools via MCP `tools/list` and `tools/call`
5. **Notifies** the client via `notifications/tools/list_changed` when tools change

```
┌──────────────┐     stdio      ┌─────────────────┐     import()     ┌────────────┐
│   OpenCode   │ ◄────────────► │  open-reload     │ ◄──────────────► │  Plugin A  │
│   (client)   │   MCP proto    │  (MCP server)    │   cache-bust     │  Plugin B  │
└──────────────┘                │                  │                  │  Plugin C  │
                                │  fs.watch() ─────┤                  └────────────┘
                                │  on change:      │
                                │    1. re-import   │
                                │    2. diff tools  │
                                │    3. notify      │
                                └─────────────────┘
```

### Why MCP over native plugin?

| Approach | Hot-reload possible? | Upstream changes? | Tool surface changes? |
|----------|---------------------|-------------------|-----------------------|
| Native plugin hack | Partial (cache bust) | Yes (patch OpenCode) | No (snapshotted) |
| MCP meta-server | Full | None | Yes (tools/list_changed) |

### Alternatives Considered

1. **Patch OpenCode** to add plugin reload — requires upstream PR, maintenance burden
2. **File-based tool registry** — plugins write JSON, server reads — too indirect, no type safety
3. **Process restart** — defeats the purpose
4. **Bun's `--hot` flag** — only works for HTTP servers with `Bun.serve()`, not MCP stdio

## Core Architecture: Shell/Brain Split

The self-reload requirement drives the entire architecture. open-reload must be able to reload its own logic at runtime.

### The Constraint

The MCP server holds a stdio pipe to OpenCode. This connection cannot be broken. But everything else — config loading, tool extraction, plugin management, tool routing — must be hot-swappable.

### Solution: Two Layers

```
┌─────────────────────────────────────────────────────┐
│  Shell (never reloads, ~100 lines total)             │
│  - MCP Server + stdio transport                      │
│  - Process lifecycle                                 │
│  - fs.watch() driver (owns handles, debounces)       │
│  - Brain loader (purge + import + atomic swap)        │
│  - 1 escape-hatch tool: openreload.reload            │
│  - Hardcoded self-watch: src/brain/** → reload brain │
├─────────────────────────────────────────────────────┤
│  Brain (hot-reloadable, all interesting logic)        │
│  - Config loading/validation                         │
│  - Module loading with cache busting                 │
│  - Tool extraction from plugins                      │
│  - Tool routing (which plugin handles which call)    │
│  - Plugin state management                           │
│  - Watch policy (which paths, ignore patterns)       │
└─────────────────────────────────────────────────────┘
```

### How It Works

1. Shell imports `src/brain/entry.ts` dynamically via cache-busting `import()`
2. Brain exports a `BrainFactory.create(ctx, init)` → returns a `BrainAPI` object
3. Shell calls `activeBrain.listTools()`, `activeBrain.callTool()`, etc.
4. On brain source change: shell purges all `src/brain/**` from Bun's module cache, re-imports `entry.ts`, creates new brain with snapshot from old brain, swaps pointer
5. If new brain fails to initialize: old brain stays active, error logged to stderr

### Atomic Swap Sequence

```
1. snapshot = activeBrain.exportSnapshot()
2. purge all src/brain/** from Loader.registry
3. newModule = import("src/brain/entry.ts?t=" + Date.now())
4. newBrain = newModule.factory.create(ctx, { snapshot })
5. if success: activeBrain.dispose() → activeBrain = newBrain
6. if failure: keep activeBrain unchanged, log error
```

### Watcher Paradox Resolution

The watcher is brain logic, but triggers brain reload. Solved by splitting **driver** (shell) from **policy** (brain):

- Shell hardcodes: "any change in `src/brain/**` → reload brain directly" (no brain consultation)
- Brain returns a `WatchPlan` for plugin directories (which paths, debounce, ignore patterns)
- Shell runs `fs.watch()` according to the plan, forwards events to `brain.onFileEvents()`
- Brain responds with effects: `{ reloadBrain?: boolean, refreshWatchPlan?: boolean }`

### Self-Reload vs Plugin Reload

Self-reload is a **control-plane** concern (separate mechanism, shell-owned).
Plugin reload is a **data-plane** concern (brain-owned).

Not treating self as "plugin index 0" avoids recursion and simplifies failure recovery.

### State That Survives Brain Reload

| Survives (shell-owned) | Rebuilt (brain-owned) |
|------------------------|-----------------------|
| MCP Server + stdio | Plugin module instances |
| Brain pointer | Tool routing tables |
| Watcher handles | Plugin runtime state |
| Last-known-good snapshot | In-flight operations |
| Last reload error | |

### BrainAPI Contract (stable, lives in shell)

```typescript
type BrainAPI = {
  listTools(): Promise<ToolSpec[]>;
  callTool(call: ToolCall): Promise<ToolResult>;
  getWatchPlan(): Promise<WatchPlan>;
  onFileEvents(events: FileEvent[]): Promise<{ reloadBrain?: boolean; refreshWatchPlan?: boolean }>;
  exportSnapshot(): Promise<BrainSnapshot>;
  dispose(): Promise<void>;
};
```

Shell never imports from `src/brain/`. The contract uses only plain objects (no classes, no brain-owned types).

## Open Questions

1. **Module cleanup**: When re-importing, do we need to clean up previous module state? Yes — brain must implement `dispose()` to clear intervals/handles.
2. **Tool state**: Survives reload only if serialized into `BrainSnapshot`. Persistence API is a Phase 3 concern.
3. **Error handling**: Last-known-good brain stays active. Shell-owned `openreload.reload` tool allows manual retry.
4. **Multi-plugin**: Single open-reload instance serves N plugins. Brain handles namespacing.
5. **Module graph purge**: Must invalidate entire `src/brain/**` tree, not just `entry.ts`, because relative imports resolve to cached modules without the `?t=` suffix.
