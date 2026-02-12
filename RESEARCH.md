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

## Open Questions

1. **Module cleanup**: When re-importing, do we need to clean up previous module state (event listeners, timers, open file handles)?
2. **Tool state**: If a tool has in-memory state (counters, caches), reload wipes it. Should we provide a persistence API?
3. **Error handling**: If a reloaded plugin has syntax errors, what's the recovery? Keep the last known good version?
4. **Multi-plugin**: Should one open-reload instance serve multiple plugins, or one instance per plugin?
5. **Config format**: How does the user specify which plugin files to watch and how to extract tools from them?
