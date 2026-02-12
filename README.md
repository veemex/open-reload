# open-reload

Self-reloading MCP meta-plugin for [OpenCode](https://opencode.ai). Watches plugin source files **and its own brain**, re-imports on change, and serves tools via MCP with live `tools/list_changed` notifications. No restart required — not even to improve the tool itself.

## Core Idea

open-reload can reload ~80% of itself at runtime. The architecture splits into:

- **Shell** (~100 lines, never reloads): MCP stdio transport, process lifecycle, watcher handles, brain swapper
- **Brain** (everything else, hot-reloadable): config loading, plugin management, tool routing, watch policy

An AI agent can edit brain code → the shell detects the change → purges the brain module graph → re-imports → atomically swaps the live brain. If the new brain fails, the old one stays active.

```
┌──────────────┐     stdio      ┌─────────────────────────────────────┐
│   OpenCode   │ <────────────> │  Shell (permanent)                  │
│   (client)   │   MCP proto    │  ┌─────────────────────────────┐    │
└──────────────┘                │  │  Brain (hot-swappable)      │    │
                                │  │  - config loading            │    │
                                │  │  - plugin cache-bust import  │    │
                                │  │  - tool extraction + routing │    │
                                │  │  - watch policy              │    │
                                │  └─────────────────────────────┘    │
                                │                                     │
                                │  fs.watch(src/brain/**) → reload    │
                                │  fs.watch(plugin dirs)  → delegate  │
                                └─────────────────────────────────────┘
```

## How Plugin Reload Works

1. **Watch** plugin source directories for `.ts`/`.js` changes
2. **Re-import** the plugin module with Bun cache busting
3. **Diff** old vs new tool list
4. **Notify** client via MCP `notifications/tools/list_changed`
5. Client re-fetches `tools/list` and gets the updated tools

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
bun run dev    # Start the MCP server (not yet implemented — see TODO.md)
bun test       # Run tests
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
      "exportType": "opencode-plugin"
    }
  ],
  "debounceMs": 300,
  "logLevel": "info"
}
```

### Plugin Export Types

| Type | Module Shape |
|------|-------------|
| `opencode-plugin` | `export default (ctx) => ({ tools: { name: tool() } })` |
| `tool-array` | `export const tools = [{ name, description, inputSchema, execute }]` |
| `mcp-tools` | `export const tools = { name: { description, inputSchema, execute } }` |

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
    brain-api.ts               # Stable contract (plain types, no brain imports)
    brain-loader.ts            # Purge + import + atomic swap
    watch-driver.ts            # fs.watch() orchestration + debouncing
    core-tools.ts              # openreload_reload, openreload_status (always work)
    mcp.ts                     # MCP server + stdio transport
    main.ts                    # Process entry
  brain/                       # HOT-RELOADABLE — all interesting logic
    entry.ts                   # BrainFactory → BrainAPI
    config/
      types.ts                 # Config + plugin state types
      loader.ts                # Config resolution + validation
    loader/
      module-loader.ts         # Bun cache-busting plugin import
    router/
      tool-router.ts           # Tool name → plugin execute routing
    watcher/
      policy.ts                # WatchPlan generation + event classification
    state/
      plugin-state.ts          # Per-plugin state management + snapshotting
```

## Architecture Invariants

1. Shell **never** imports from `src/brain/`. Contract lives in `src/shell/brain-api.ts`.
2. Brain reload invalidates the **entire** `src/brain/**` module graph.
3. Brain reload is **atomic**: new brain succeeds or old brain stays.
4. `openreload_reload` tool **always works**, even if brain is broken.
5. Shell self-watch triggers reload **without consulting brain**.

## Status

**Phase 0** — Shell/brain architecture scaffolded. See [TODO.md](./TODO.md) for the full roadmap and [RESEARCH.md](./RESEARCH.md) for research findings.

## License

MIT
