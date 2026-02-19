# open-reload

Self-reloading MCP meta-plugin for [OpenCode](https://opencode.ai). Watches plugin source files **and its own brain**, re-imports on change, and serves tools, resources, and prompts via MCP with live `tools/list_changed` notifications. No restart required — not even to improve the tool itself.

**v2** — Full plugin platform with context threading, Zod schema passthrough, cross-plugin events, MCP resources, MCP prompts, multi-agent namespace routing, plugin dependency resolution, and persistent state.

## Core Idea

open-reload can reload ~80% of itself at runtime. The architecture splits into:

- **Shell** (~100 lines, never reloads): MCP stdio transport, process lifecycle, watcher handles, brain swapper
- **Brain** (everything else, hot-reloadable): config loading, plugin management, tool/resource/prompt routing, watch policy, event bus, state persistence

An AI agent can edit brain code → the shell detects the change → purges the brain module graph → re-imports → atomically swaps the live brain. If the new brain fails, the old one stays active.

Plugins return tools, resources, prompts, and a dispose hook. The brain threads per-call context (CWD, session ID, agent ID) to plugin execute functions, passes Zod schemas through for client-side validation, and routes events between plugins.

```
┌──────────────┐     stdio      ┌──────────────────────────────────────────┐
│   OpenCode   │ <────────────> │  Shell (permanent)                       │
│   (client)   │   MCP proto    │  ┌────────────────────────────────────┐  │
└──────────────┘                │  │  Brain (hot-swappable)             │  │
                                │  │  - config loading                   │  │
                                │  │  - plugin cache-bust import         │  │
                                │  │  - tool/resource/prompt extraction  │  │
                                │  │  - tool routing + context threading │  │
                                │  │  - cross-plugin event bus           │  │
                                │  │  - dependency-ordered loading       │  │
                                │  │  - namespace + agent filtering      │  │
                                │  │  - persistent state (snapshot)      │  │
                                │  │  - system prompts                   │  │
                                │  │  - watch policy                     │  │
                                │  └────────────────────────────────────┘  │
                                │                                          │
                                │  fs.watch(src/brain/**) → reload         │
                                │  fs.watch(plugin dirs)  → delegate       │
                                └──────────────────────────────────────────┘
```

## How Plugin Reload Works

1. **Watch** plugin source directories for `.ts`/`.js` changes
2. **Re-import** the plugin module with Bun cache busting
3. **Diff** old vs new tool/resource/prompt list
4. **Notify** client via MCP `notifications/tools/list_changed`
5. Client re-fetches `tools/list` and gets the updated tools

When a plugin with dependents changes, all downstream plugins are reloaded in dependency order. Each plugin's `dispose()` hook is called before re-import.

## How Self-Reload Works

1. Shell hardcodes a watcher on `src/brain/**`
2. On any change: purge all brain modules from `Loader.registry`
3. Re-import `src/brain/entry.ts` with cache-busting query string
4. Call `factory.create(ctx, { snapshot })` with state from old brain
5. If success: dispose old brain, swap pointer. If failure: keep old brain.

## Why MCP?

| Approach | Hot-reload? | Self-reload? | Upstream changes? |
|----------|------------|-------------|-------------------|
| Native plugin | No | No | N/A |
| MCP meta-server | **Yes** | **~80%** | **None** |

## Quick Start

```bash
bun install
bun run dev    # Start the MCP server
bun test       # Run tests (158 tests across 22 files)
```

## Configuration

Create `open-reload.json` in one of:
- `.opencode/open-reload.json` (local project)
- `~/.config/open-reload/open-reload.json` (global)

```json
{
  "plugins": [
    {
      "name": "my-plugin",
      "entry": "/absolute/path/to/plugin/src/index.ts",
      "watchDir": "/absolute/path/to/plugin/src",
      "exportType": "opencode-plugin",
      "namespace": "my-namespace",
      "agentVisibility": ["build", "oracle"],
      "dependsOn": ["core-plugin"]
    }
  ],
  "debounceMs": 300,
  "logLevel": "info",
  "logFile": "/tmp/open-reload.log",
  "systemPrompts": [
    {
      "name": "project-context",
      "content": "This project uses Bun and TypeScript.",
      "priority": 10
    }
  ],
  "statePath": "/tmp/open-reload-state.json"
}
```

### Configuration Fields

| Field | Purpose |
|-------|---------|
| `plugins[].name` | Unique plugin identifier |
| `plugins[].entry` | Absolute path to plugin entry file |
| `plugins[].watchDir` | Directory to watch for changes (defaults to entry's parent) |
| `plugins[].exportType` | Module shape: `opencode-plugin`, `tool-array`, or `mcp-tools` |
| `plugins[].prefix` | Prefix tool names with plugin name (default: true) |
| `plugins[].worktreePath` | Worktree root — loads plugin from worktree instead of parent repo |
| `plugins[].namespace` | Namespace for multi-agent tool filtering |
| `plugins[].agentVisibility` | Restrict tool visibility to specific agent IDs |
| `plugins[].dependsOn` | Array of plugin names this plugin depends on (controls load order) |
| `debounceMs` | File change debounce interval (default: 300) |
| `logLevel` | Log verbosity: `error`, `warn`, `info`, `debug` |
| `logFile` | Write logs to file in addition to stderr |
| `systemPrompts` | Brain-level MCP prompts injected as `system:<name>` |
| `systemPrompts[].priority` | Higher priority = earlier in prompt list |
| `statePath` | Absolute path for disk-backed snapshot persistence |

### Plugin Export Types

| Type | Module Shape | Returns |
|------|-------------|---------|
| `opencode-plugin` | `export default (ctx) => ({ tool, resource?, prompt?, dispose? })` | Tools + resources + prompts + dispose hook |
| `tool-array` | `export const tools = [{ name, description, inputSchema, execute }]` | Tools only |
| `mcp-tools` | `export const tools = { name: { description, inputSchema, execute } }` | Tools only |

The `opencode-plugin` format supports the full v2 feature set. Plugin functions receive a context object with `directory`, `worktree`, and an `events` object for cross-plugin communication.

## Plugin Capabilities

### Context Threading

Every tool call receives a `ToolCallContext` with the caller's CWD, session ID, and agent ID. This is forwarded to plugin execute functions so they can resolve paths and tailor behavior per-agent.

```typescript
type ToolCallContext = {
  cwd: string;
  sessionId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
};
```

### Zod Schema Passthrough

Plugins using `opencode-plugin` format can define args with Zod schemas via `tool.schema.*`. open-reload converts these to JSON Schema for MCP transport and passes the original Zod schema as `zodInputSchema` for clients that support it.

### Cross-Plugin Events

Plugins can emit and subscribe to typed events via the event bus:

```typescript
// In plugin execute function (via context.events)
context.events.emit("build:complete", { path: "/dist" });
context.events.on("build:complete", (event) => { /* react */ });
```

Event handlers are automatically cleaned up when a plugin is reloaded or disposed.

### MCP Resources

Plugins can expose readable resources (files, data streams, etc.) via the `resource` map:

```typescript
export default (ctx) => ({
  tool: { /* ... */ },
  resource: {
    "project://status": {
      description: "Current project status",
      mimeType: "application/json",
      read: async () => JSON.stringify({ healthy: true }),
    },
  },
});
```

### MCP Prompts

Plugins can expose prompt templates via the `prompt` map:

```typescript
export default (ctx) => ({
  tool: { /* ... */ },
  prompt: {
    "review-code": {
      description: "Code review prompt",
      arguments: [{ name: "file", required: true }],
      get: async (args) => [
        { role: "user", content: { type: "text", text: `Review ${args.file}` } },
      ],
    },
  },
});
```

Brain-level system prompts (configured in `open-reload.json`) are also served as MCP prompts with the `system:` prefix.

### Plugin Dispose

Plugins can return a `dispose` function that is called before reload or shutdown:

```typescript
export default (ctx) => ({
  tool: { /* ... */ },
  dispose: async () => {
    // Clean up connections, timers, etc.
  },
});
```

## Multi-Agent Routing

Plugins can be scoped to specific agents using `namespace` and `agentVisibility`:

- **`namespace`**: Groups tools under a logical namespace. When the router filters by namespace, only tools in the matching namespace are returned.
- **`agentVisibility`**: Restricts tool visibility to specific agent IDs. A tool with `agentVisibility: ["build"]` is only visible to the `build` agent.

```json
{
  "plugins": [
    {
      "name": "deploy-tools",
      "entry": "/path/to/deploy/index.ts",
      "exportType": "opencode-plugin",
      "namespace": "infrastructure",
      "agentVisibility": ["build", "deploy"]
    }
  ]
}
```

## Plugin Dependencies

Plugins can declare dependencies via `dependsOn`. open-reload performs topological sorting to ensure plugins load in the correct order. Circular dependencies are detected and rejected at startup.

When a dependency is reloaded (due to file changes), all downstream dependents are reloaded in order.

```json
{
  "plugins": [
    { "name": "core", "entry": "/path/to/core.ts", "exportType": "opencode-plugin" },
    { "name": "auth", "entry": "/path/to/auth.ts", "exportType": "opencode-plugin", "dependsOn": ["core"] },
    { "name": "api", "entry": "/path/to/api.ts", "exportType": "opencode-plugin", "dependsOn": ["core", "auth"] }
  ]
}
```

## Persistent State

When `statePath` is configured, the brain saves a snapshot of plugin state (reload counts, tool/resource/prompt inventories) to disk on dispose. On next startup, the snapshot is restored so plugins retain their reload history across process restarts.

```json
{
  "statePath": "/tmp/open-reload-state.json"
}
```

## Worktree-Aware Reload

Plugins can be loaded from git worktrees instead of the parent repo. Set `worktreePath` to the worktree's source directory — open-reload resolves the entry point relative to this path while keeping the original `watchDir` for change detection.

This enables per-task plugin development: create a worktree, edit the plugin, and open-reload loads the worktree version without affecting other environments.

```json
{
  "plugins": [
    {
      "name": "my-plugin",
      "entry": "/repos/my-plugin/src/index.ts",
      "watchDir": "/repos/my-plugin/src",
      "worktreePath": "/worktrees/env_abc/my-plugin/src",
      "exportType": "opencode-plugin"
    }
  ]
}
```

## Agent Setup

**OpenCode** (`settings.json` or equivalent):
```json
{
  "mcpServers": {
    "open-reload": {
      "command": "bun",
      "args": ["run", "/path/to/open-reload/src/shell/main.ts"]
    }
  }
}
```

## Project Structure

```
src/
  index.ts                     # Barrel exports
  shell/                       # PERMANENT — never reloads
    brain-api.ts               # Stable contract: ToolCallContext, ResourceSpec, PromptSpec, BrainAPI
    brain-loader.ts            # Purge + import + atomic swap
    watch-driver.ts            # fs.watch() orchestration + debouncing
    core-tools.ts              # openreload_reload, openreload_status (always work)
    mcp.ts                     # MCP server + stdio transport (tools, resources, prompts)
    main.ts                    # Process entry
  brain/                       # HOT-RELOADABLE — all interesting logic
    entry.ts                   # BrainFactory → BrainAPI, topoSort, dependency-cascading reload
    config/
      types.ts                 # PluginConfig (namespace, dependsOn, agentVisibility), OpenReloadConfig (systemPrompts, statePath)
      loader.ts                # Config resolution + validation
    loader/
      module-loader.ts         # Bun cache-busting plugin import, tool/resource/prompt extraction
    router/
      tool-router.ts           # Tool name → plugin execute routing, namespace + agent filtering
    events/
      event-bus.ts             # Cross-plugin event bus with per-plugin handler tracking
    watcher/
      policy.ts                # WatchPlan generation + event classification
    state/
      plugin-state.ts          # Per-plugin state management, snapshots, resource/prompt tracking
```

## Architecture Invariants

1. Shell **never** imports from `src/brain/`. Contract lives in `src/shell/brain-api.ts`.
2. Brain reload invalidates the **entire** `src/brain/**` module graph.
3. Brain reload is **atomic**: new brain succeeds or old brain stays.
4. `openreload_reload` tool **always works**, even if brain is broken.
5. Shell self-watch triggers reload **without consulting brain**.
6. Plugin dependencies are topologically sorted — circular dependencies are rejected.
7. Event handlers are cleaned up on plugin reload — no leaked subscriptions.
8. Persistent state uses atomic write (write to `.tmp`, rename) — no partial snapshots.

## License

MIT
