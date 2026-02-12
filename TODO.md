# open-reload — Implementation Roadmap

## Phase 0: Foundation

- [ ] **P0-1**: Define config schema — what the user provides to tell open-reload which plugins to watch
  - Plugin path(s) to watch
  - Module export format (default export function? named export? tool array?)
  - Watch options (debounce interval, ignored patterns)
  - Example:
    ```json
    {
      "plugins": [
        {
          "name": "my-plugin",
          "entry": "/path/to/plugin/src/index.ts",
          "watchDir": "/path/to/plugin/src",
          "exportType": "opencode-plugin"
        }
      ],
      "debounceMs": 300
    }
    ```

- [ ] **P0-2**: Implement module loader with cache busting
  - Load a TypeScript module via `import()`
  - Force re-import by clearing Bun's module cache + query string timestamp
  - Handle import errors gracefully (syntax errors, missing exports)
  - Keep last-known-good module on failure
  - Unit tests: load, reload, error recovery

- [ ] **P0-3**: Implement tool extractor
  - Given a loaded module, extract tool definitions
  - Support OpenCode plugin format: `default export (ctx) => ({ tools: { name: tool() } })`
  - Support raw tool array format: `export const tools = [...]`
  - Normalize to MCP tool format (`tools/list` response shape)
  - Unit tests: various export shapes

## Phase 1: MCP Server Core

- [ ] **P1-1**: Scaffold MCP server with stdio transport
  - Use `@modelcontextprotocol/sdk` Server class
  - Register `tools/list` handler — returns currently loaded tools from all plugins
  - Register `tools/call` handler — routes call to the correct plugin's tool execute function
  - Verify basic lifecycle: client connects, lists tools, calls a tool

- [ ] **P1-2**: Implement file watcher
  - Watch plugin directories via `fs.watch()` (or `Bun.watch()` if stable)
  - Debounce rapid changes (save + format = 2 events)
  - On change: trigger reload for the affected plugin only
  - Ignore patterns: `node_modules`, `.git`, `*.test.ts`

- [ ] **P1-3**: Wire reload → notify
  - On successful reload: diff old vs new tool list
  - If tools changed (added, removed, schema changed): send `notifications/tools/list_changed`
  - If tools unchanged: skip notification (no-op reload)
  - Log reload events with timestamp and diff summary

## Phase 2: Robustness

- [ ] **P2-1**: Error recovery and last-known-good
  - If re-import fails (syntax error, runtime error): keep previous tool set active
  - Log the error with full stack trace
  - Provide a `reload-status` meta-tool that reports current state of each plugin
  - On next successful reload: clear error state

- [ ] **P2-2**: Graceful tool execution during reload
  - Handle race: tool call arrives during reload
  - Options: queue calls during reload, or serve from last-known-good
  - Ensure no partial state (tool list from plugin A + stale plugin B)

- [ ] **P2-3**: Module cleanup on reload
  - Before re-importing, call a cleanup hook if the plugin exports one: `export function dispose() { ... }`
  - Clear any intervals/timeouts the old module registered
  - Prevent memory leaks from accumulated module instances

## Phase 3: Developer Experience

- [ ] **P3-1**: CLI interface
  - `open-reload start` — starts the MCP server with config
  - `open-reload status` — shows watched plugins and their state
  - `open-reload reload <plugin>` — force manual reload

- [ ] **P3-2**: Meta-tools (tools that open-reload itself exposes)
  - `reload_status` — list all managed plugins, their load state, last reload time, errors
  - `reload_force` — manually trigger reload of a specific plugin
  - `reload_config` — show current open-reload configuration

- [ ] **P3-3**: Logging and diagnostics
  - Structured JSON log to file (similar to opencodingbox's debug tracer)
  - Log levels: error, warn, info, debug
  - Include: reload events, tool diffs, errors, call routing

## Phase 4: Multi-Plugin & Advanced

- [ ] **P4-1**: Multi-plugin support
  - Single open-reload instance serves tools from N plugins
  - Tool name namespacing to avoid collisions: `pluginName_toolName`
  - Independent reload per plugin (plugin A reload doesn't affect plugin B)

- [ ] **P4-2**: Config hot-reload
  - Watch the open-reload config file itself
  - Add/remove plugins at runtime without restart
  - Handle new plugin: start watching + initial load
  - Handle removed plugin: stop watching + remove tools + notify

- [ ] **P4-3**: Performance
  - Measure reload latency (target: < 500ms from file save to tools/list_changed)
  - Profile memory growth over many reloads
  - Implement module instance cap (keep last N, GC the rest)

## Out of Scope (for now)

- **Native plugin hot-reload** — requires patching OpenCode upstream
- **Cross-machine reload** — MCP over network transport (possible but not priority)
- **GUI** — no visual interface, CLI + MCP tools only
- **Plugin marketplace** — discovery/installation of plugins
