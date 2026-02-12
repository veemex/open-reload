# open-reload

Hot-reload MCP meta-plugin for [OpenCode](https://opencode.ai). Watches plugin source files, re-imports on change, and serves tools via MCP with live `tools/list_changed` notifications. No OpenCode restart required.

## How It Works

```
┌──────────────┐     stdio      ┌─────────────────┐     import()     ┌────────────┐
│   OpenCode   │ <────────────> │  open-reload     │ <──────────────> │  Plugin A  │
│   (client)   │   MCP proto    │  (MCP server)    │   cache-bust     │  Plugin B  │
└──────────────┘                │                  │                  │  Plugin C  │
                                │  fs.watch() ─────┤                  └────────────┘
                                │  on change:      │
                                │    1. re-import   │
                                │    2. diff tools  │
                                │    3. notify      │
                                └─────────────────┘
```

1. **Watch** plugin source directories for `.ts`/`.js` changes
2. **Re-import** the plugin module with Bun cache busting
3. **Diff** old vs new tool list
4. **Notify** client via MCP `notifications/tools/list_changed`
5. Client re-fetches `tools/list` and gets the updated tools

OpenCode's MCP client already handles `tools/list_changed` natively — no upstream changes needed.

## Why MCP Instead of Native Plugin?

| Approach | Hot-reload? | Upstream changes? | Tool add/remove at runtime? |
|----------|------------|-------------------|-----------------------------|
| Native plugin hack | Partial | Yes | No (tools snapshotted at startup) |
| **MCP meta-server** | **Full** | **None** | **Yes** |

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
      "args": ["run", "/path/to/open-reload/src/index.ts"]
    }
  }
}
```

## Project Structure

```
src/
  index.ts                 # Entry point — exports all modules
  config/
    types.ts               # Config + runtime state type definitions
    loader.ts              # Config file resolution + validation
  loader/
    module-loader.ts       # Plugin import with Bun cache busting
  watcher/
    file-watcher.ts        # Debounced recursive file watcher
  server/
    mcp-server.ts          # MCP server (Phase 1 — not yet implemented)
```

## Status

**Phase 0** — Foundation scaffolded. See [TODO.md](./TODO.md) for the full roadmap and [RESEARCH.md](./RESEARCH.md) for the technical research behind this approach.

## License

MIT
