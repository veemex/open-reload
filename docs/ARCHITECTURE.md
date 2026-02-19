# Architecture: Data Flow Through open-reload

How data flows through the open-reload + opencodingbox system, traced through
actual file names and function names. For project structure and conventions,
see the root `AGENTS.md`.

---

## 1. System Overview

```
 ┌─────────────┐
 │  AI Agent    │  (Claude Code, OpenCode, Codex CLI)
 └──────┬──────┘
        │ JSON-RPC over stdio
        │
 ┌──────▼──────────────────────────────────────────────────────┐
 │  SHELL  (permanent — never reloads)                         │
 │                                                             │
 │  main.ts           Process lifecycle, watcher setup         │
 │  mcp.ts            MCP server, tool/resource/prompt sync    │
 │  brain-loader.ts   Brain swap: snapshot → purge → reload    │
 │  watch-driver.ts   fs.watch wrapper with debounce           │
 │  core-tools.ts     openreload_reload, openreload_status     │
 │  brain-api.ts      All types that cross the boundary        │
 │                                                             │
 │  Owns: MCP connection, file watchers, process signals       │
 └──────┬──────────────────────────────────────────────────────┘
        │ BrainAPI interface (brain-api.ts)
        │
 ┌──────▼──────────────────────────────────────────────────────┐
 │  BRAIN  (hot-swappable — reloads on src/brain/** changes)   │
 │                                                             │
 │  entry.ts           BrainFactory, plugin loading, topoSort  │
 │  config/loader.ts   Parse open-reload.json                  │
 │  config/types.ts    PluginConfig, ManagedTool, PluginState  │
 │  loader/module-loader.ts   Schema extraction, context build │
 │  router/tool-router.ts     Tool routing by qualifiedName    │
 │  events/event-bus.ts       Cross-plugin event propagation   │
 │  state/plugin-state.ts     Plugin state, snapshots          │
 │  watcher/policy.ts         Watch plan + event classification│
 │                                                             │
 │  Owns: Config, plugin loading, routing, state, events       │
 └──────┬──────────────────────────────────────────────────────┘
        │ Plugin execute() calls
        │
 ┌──────▼──────────────────────────────────────────────────────┐
 │  PLUGINS  (each reloads independently on watchDir changes)  │
 │                                                             │
 │  opencodingbox/src/index.ts    Plugin entry (8 tools)       │
 │  opencodingbox/src/tools/*.ts  Tool implementations         │
 │                                                             │
 │  Owns: Business logic, tool execution, resources, prompts   │
 └─────────────────────────────────────────────────────────────┘

Data flows:
  Tool calls:    Agent → Shell → Brain → Plugin → Brain → Shell → Agent
  Resources:     Agent → Shell → Brain → Plugin.read() → back
  Prompts:       Agent → Shell → Brain → Plugin.get() or systemPrompt → back
  Events:        Plugin A → PluginEventBus → Plugin B
  File changes:  fs.watch → Shell → Brain.onFileEvents() → plugin reload
  Brain reload:  fs.watch → Shell → swapBrain() → new Brain instance
```

---

## 2. Flow: Tool Call (Happy Path)

A single tool call from agent request to plugin execution and back.

```
Agent sends: tools/call { name: "environment_new_task", arguments: { branch: "feat/login" } }
  │
  ▼
mcp.ts ─ McpServer handler (registered in syncBrainTools)
  │  Constructs context: { cwd: opts.getCwd() ?? process.cwd() }
  │  Calls: brain.callTool({ name, arguments: args, context })
  │
  ▼
entry.ts ─ Brain.callTool(call: ToolCall)
  │  Delegates to: this.router.route(call)
  │
  ▼
tool-router.ts ─ ToolRouter.route(call: ToolCall)
  │  Looks up: this.routes.get(call.name)  → ManagedTool
  │  Calls: tool.execute(args, call.context)
  │
  ▼
module-loader.ts ─ ManagedTool.execute (closure built during extractFromOpenCodePlugin)
  │  Builds opencode-plugin context from ToolCallContext:
  │    {
  │      sessionID:  ctx.sessionId ?? "open-reload"
  │      messageID:  "open-reload"
  │      agent:      ctx.agentId ?? "open-reload"
  │      directory:  ctx.cwd ?? cwd
  │      worktree:   ctx.cwd ?? cwd
  │      abort:      new AbortController().signal
  │      events:     { emit, on }  ← wired to PluginEventBus
  │    }
  │  Calls: originalExecute(input, execContext)
  │
  ▼
opencodingbox/src/index.ts ─ plugin tool execute(args)
  │  Calls implementation: createNewTaskEnvironment({ branch: "feat/login", ... })
  │  Returns: JSON.stringify(result)
  │
  ▼ (return path)
tool-router.ts ─ Wraps string in ToolResult: { content: [{ type: "text", text: result }] }
  │
  ▼
entry.ts ─ Brain.callTool returns ToolResult
  │
  ▼
mcp.ts ─ MCP SDK serializes ToolResult to JSON-RPC response
  │
  ▼
Agent receives result
```

**Error path**: If `tool.execute()` throws, `ToolRouter.route()` catches and
returns `{ content: [{ type: "text", text: "Tool error: ..." }], isError: true }`.

---

## 3. Flow: Schema Registration

How tool schemas flow from plugin definition to agent discovery.

```
Plugin source (opencodingbox/src/index.ts):
  │  tool({ args: { branch: tool.schema.string().describe("Branch name") } })
  │  The args object contains raw Zod shape values (ZodString, ZodOptional, etc.)
  │
  ▼
module-loader.ts ─ extractFromOpenCodePlugin()
  │  Step 1: Reads def.args (the raw Zod shape object)
  │  Step 2: zodInputSchema = z.object(def.args)        ← Zod object schema
  │  Step 3: inputSchema = z.toJSONSchema(zodInputSchema) ← JSON Schema for storage
  │  Step 4: Stores both on ManagedTool:
  │            .zodInputSchema  (for MCP SDK registration)
  │            .inputSchema     (for BrainAPI.listTools)
  │
  ▼
entry.ts ─ Brain.listTools()
  │  Calls: this.router.listSpecs()
  │
  ▼
tool-router.ts ─ ToolRouter.listSpecs()
  │  Maps each ManagedTool → ToolSpec:
  │    { name: qualifiedName, description, inputSchema, zodInputSchema }
  │
  ▼
mcp.ts ─ syncBrainTools()
  │  For each ToolSpec from brain.listTools():
  │    Casts: tool.zodInputSchema as McpInputSchema
  │    Registers: server.registerTool(tool.name, { inputSchema: zodSchema }, handler)
  │  Calls: server.sendToolListChanged()
  │
  ▼
Agent receives updated tools/list with full parameter descriptions

Key detail: zodInputSchema is typed as `unknown` in brain-api.ts (ToolSpec)
to avoid shell → Zod dependency. The shell treats it as opaque and passes
it directly to the MCP SDK which expects Zod schemas.
```

**Alternate formats** (`tool-array`, `mcp-tools`): These start with a plain
JSON Schema `inputSchema` and use `z.fromJSONSchema()` to reconstruct a
`zodInputSchema`. The flow from Brain → MCP is identical.

---

## 4. Flow: Plugin Reload (File Change)

What happens when a plugin file changes on disk.

```
Developer saves opencodingbox/src/tools/new-task.ts
  │
  ▼
watch-driver.ts ─ FileWatcher (one per watchDir root)
  │  fs.watch detects change, debounces (default 300ms)
  │  Filters: only .ts/.js/.mts/.mjs, ignores node_modules/.git/dist
  │  Calls: options.onChange(fullPath)
  │
  ▼
main.ts ─ onPluginFileChange(changedPath)
  │  Creates: FileEvent { path: changedPath, kind: "change" }
  │  Calls: activeBrain.onFileEvents([event])
  │
  ▼
entry.ts ─ Brain.onFileEvents(events)
  │  Step 1: classifyEvents(events, stateManager.getAllStates())
  │          └─ policy.ts: matches event.path against each plugin's watchDir
  │             Returns: { reloadPlugins: ["environment"], reloadBrain: false }
  │
  │  Step 2: getReloadOrder(["environment"], config.plugins)
  │          └─ Walks dependsOn graph to find transitive dependents
  │             If plugin B dependsOn A and A changed → reload both [A, B]
  │
  │  Step 3: For each plugin in reload order:
  │    a. eventBus.removePlugin(pluginName)  ← cleans up event handlers
  │    b. oldState.dispose?.()               ← plugin cleanup hook
  │    c. stateManager.setLoading(name, config)
  │    d. loadPluginModule(pluginConfig, eventBus)
  │       └─ module-loader.ts:
  │          - purgePluginModules(): clears Bun module registry for watchDir
  │          - import(`${entry}?t=${Date.now()}`)  ← cache-busting re-import
  │          - extractTools(): re-extract schemas, rebuild execute closures
  │    e. stateManager.setLoaded(name, config, tools, resources, prompts, dispose)
  │
  │  Step 4: router.rebuild(stateManager.getAllTools())
  │          └─ tool-router.ts: clears and rebuilds routes Map
  │
  │  Returns: { reloadBrain: false, refreshWatchPlan: false }
  │
  ▼
main.ts ─ onPluginFileChange (continued)
  │  effects.reloadBrain is false, so:
  │  Calls: mcp.syncBrainTools()    ← re-registers tools with MCP SDK
  │  Calls: mcp.syncBrainResources() ← re-registers resources
  │  Calls: mcp.syncBrainPrompts()   ← re-registers prompts
  │  Each sync: removes old handles, registers new, sends listChanged notification
  │
  ▼
Agent receives tools/list_changed notification (updated tool set)
```

**Error handling**: If `loadPluginModule` throws, the plugin enters
`status: "error"` but keeps its last-known-good tools via
`PluginStateManager.setError()` preserving `existing.tools`.

---

## 5. Flow: Brain Self-Reload

What happens when brain code itself changes (`src/brain/**`).

```
Developer saves open-reload/src/brain/router/tool-router.ts
  │
  ▼
watch-driver.ts ─ FileWatcher (selfWatcher in main.ts)
  │  Watches: BRAIN_DIR = resolve(import.meta.dir, "..", "brain")
  │  Debounces (300ms), calls onChange callback
  │
  ▼
main.ts ─ selfWatcher onChange → reload()
  │
  ▼
main.ts ─ reload()
  │  Calls: swapBrain(ctx, activeBrain, configPath)
  │
  ▼
brain-loader.ts ─ swapBrain(ctx, activeBrain, configPath)
  │
  │  Step 1: activeBrain.exportSnapshot()
  │          └─ entry.ts → stateManager.toSnapshot()
  │             └─ plugin-state.ts: serializes each PluginState to JSON:
  │                { plugins: { "environment": { reloadCount, status, toolNames, ... } } }
  │
  │  Step 2: loadBrain(ctx, { snapshot, configPath })
  │    a. purgeBrainModules()
  │       └─ Walks all .ts/.js files under src/brain/
  │          Deletes each from Bun's Loader.registry
  │    b. import(`${BRAIN_ENTRY}?t=${Date.now()}`)
  │       └─ Fresh import of src/brain/entry.ts (and all its dependencies)
  │    c. factory.create(ctx, { snapshot, configPath })
  │       └─ entry.ts create():
  │          1. loadConfig(configPath)          ← re-parse open-reload.json
  │          2. topoSort(config.plugins)        ← Kahn's algorithm, cycle detection
  │          3. new PluginStateManager()
  │          4. stateManager.restoreFromSnapshot(snapshot)
  │             └─ Restores reloadCount per plugin (metadata only)
  │          5. For each plugin: loadPluginModule() ← full re-load
  │          6. new ToolRouter(stateManager.getAllTools())
  │          7. buildWatchPlan(config)
  │          8. return new Brain(ctx, config, router, stateManager, watchPlan, eventBus)
  │
  │  Step 3: activeBrain.dispose()
  │          └─ If statePath configured: atomic write (tmp + rename)
  │             eventBus.clear(), dispose each plugin
  │
  │  Step 4: activeBrain = newBrain (atomic swap)
  │
  │  On failure: swapBrain returns the old brain (no-op swap)
  │
  ▼
main.ts ─ reload() (continued)
  │  Updates: toolCount, reloadCount, lastReloadAt
  │  Calls: mcp.syncBrainTools(), syncBrainResources(), syncBrainPrompts()
  │  Calls: syncPluginWatchers()
  │         └─ Compares brain.getWatchPlan().roots with pluginWatchers Map
  │            Starts new watchers, stops removed ones
  │
  ▼
Agent receives tools/list_changed, resources/list_changed, prompts/list_changed
```

**Key invariant**: The MCP connection (stdio transport) is NEVER interrupted
during brain reload. The shell holds it permanently.

---

## 6. Flow: Cross-Plugin Event

How events propagate between plugins via the PluginEventBus.

```
Plugin A tool execute runs:
  │  context.events.emit("task:created", { envId: "env_abc123" })
  │
  ▼
module-loader.ts ─ execContext.events.emit closure
  │  Calls: eventBus.emit({
  │    source: "pluginA",
  │    type: "task:created",
  │    payload: { envId: "env_abc123" },
  │    timestamp: Date.now()
  │  })
  │
  ▼
event-bus.ts ─ PluginEventBus.emit(event)
  │  Looks up: this.handlers.get("task:created")  → Set<EventHandler>
  │  For each handler in the set:
  │    await handler(event)   ← errors are silently caught
  │
  ▼
Plugin B handler receives event
  │  (Registered earlier via context.events.on("task:created", handler))
  │
  ▼
event-bus.ts ─ PluginEventBus.on(eventType, handler, pluginName)
  │  Stores handler in two maps:
  │    this.handlers: Map<eventType, Set<EventHandler>>       ← for dispatch
  │    this.pluginHandlers: Map<pluginName, Set<Registration>> ← for cleanup
  │  Returns: unsubscribe function

Handler cleanup on plugin reload:
  │  entry.ts → eventBus.removePlugin(pluginName)
  │  └─ event-bus.ts: iterates pluginHandlers.get(pluginName)
  │     Removes each handler from this.handlers
  │     Deletes the plugin's registration set
```

**Design**: Per-plugin handler tracking ensures that when Plugin B reloads,
only Plugin B's handlers are removed. Plugin A's handlers survive.

---

## 7. Flow: Resource Access

How agents access plugin-exposed resources.

```
Agent sends: resources/list
  │
  ▼
mcp.ts ─ syncBrainResources() registered each resource with server.registerResource()
  │  MCP SDK handles the list response automatically
  │
  ▼
Agent receives: [{ uri: "env://status", name: "env://status", description: "...", mimeType: "..." }]

Agent sends: resources/read { uri: "env://status" }
  │
  ▼
mcp.ts ─ resource handler (registered in syncBrainResources)
  │  Calls: brain.readResource(uri.toString())
  │
  ▼
entry.ts ─ Brain.readResource(uri)
  │  Searches: stateManager.getAllResources().find(r => r.uri === uri)
  │  Calls: resource.read()
  │  └─ ManagedResource.read() was built in module-loader.ts
  │     from plugin's resource definition: resourceDef.read()
  │  Returns: { uri, text, mimeType }
  │
  ▼
mcp.ts ─ wraps in MCP response: { contents: [{ uri, text, mimeType }] }
  │
  ▼
Agent receives resource content

Registration flow (at plugin load time):
  module-loader.ts ─ extractFromOpenCodePlugin()
    │  Reads resultObj.resource map
    │  For each entry: creates ManagedResource { uri, name, read, ... }
    │
    ▼
  entry.ts ─ stateManager.setLoaded(name, config, tools, resources, prompts)
    │
    ▼
  mcp.ts ─ syncBrainResources()
    │  Calls: brain.listResources()
    │  For each ResourceSpec: server.registerResource(name, uri, opts, readHandler)
    │  Calls: server.sendResourceListChanged()
```

**Prompts** follow the same pattern but additionally support system prompts
defined in `open-reload.json`. System prompts are prefixed with `"system:"`
and sorted by priority in `buildSystemPromptSpecs()` (entry.ts).

---

## 8. Boundary Diagram

What can import what. The critical rule: **Shell NEVER imports from brain/**.

```
 ┌──────────────────────────────────────────────────────────────────┐
 │                         SHELL                                    │
 │                                                                  │
 │  main.ts ──────────► brain-loader.ts                             │
 │    │                    │                                        │
 │    │                    │  import(`src/brain/entry.ts`)           │
 │    │                    │  (dynamic only — never static import)   │
 │    │                    │                                        │
 │    ├──────────────► mcp.ts                                       │
 │    │                    │                                        │
 │    ├──────────────► watch-driver.ts                               │
 │    │                                                             │
 │    └──────────────► core-tools.ts                                │
 │                                                                  │
 │  brain-api.ts ◄──── imported by everything in shell/             │
 │    (defines: BrainAPI, ToolSpec, ToolCallContext,                 │
 │     ToolCall, ToolResult, ResourceSpec, ResourceContent,         │
 │     PromptSpec, PromptMessage, FileEvent, WatchPlan,             │
 │     BrainSnapshot, BrainContext, BrainInit, BrainFactory,        │
 │     FileEventEffects)                                            │
 │                                                                  │
 └──────────────────────────┬───────────────────────────────────────┘
                            │
              BrainAPI interface only
              (no static imports across this line)
                            │
 ┌──────────────────────────▼───────────────────────────────────────┐
 │                         BRAIN                                    │
 │                                                                  │
 │  entry.ts ──────► config/loader.ts                               │
 │    │              config/types.ts                                 │
 │    │                                                             │
 │    ├────────────► loader/module-loader.ts                         │
 │    │                                                             │
 │    ├────────────► router/tool-router.ts                           │
 │    │                                                             │
 │    ├────────────► events/event-bus.ts                             │
 │    │                                                             │
 │    ├────────────► state/plugin-state.ts                           │
 │    │                                                             │
 │    └────────────► watcher/policy.ts                               │
 │                                                                  │
 │  Brain CAN import from shell/brain-api.ts (types only)           │
 │  Brain CANNOT import from shell/mcp.ts, main.ts, etc.            │
 │                                                                  │
 └──────────────────────────┬───────────────────────────────────────┘
                            │
              dynamic import (cache-busted)
                            │
 ┌──────────────────────────▼───────────────────────────────────────┐
 │                        PLUGINS                                   │
 │                                                                  │
 │  Loaded via: import(`${entry}?t=${Date.now()}`)                  │
 │  Receive: opencode-plugin context built in module-loader.ts      │
 │  Return: { tool: {...}, resource: {...}, prompt: {...} }         │
 │                                                                  │
 │  Plugins CANNOT import from brain/ or shell/                     │
 │  Plugins use the @opencode-ai/plugin SDK only                    │
 │                                                                  │
 └──────────────────────────────────────────────────────────────────┘

Import rule summary:
  shell/ → brain-api.ts types (static), brain/entry.ts (dynamic only)
  brain/ → shell/brain-api.ts types (static)
  plugins/ → @opencode-ai/plugin SDK only (no open-reload imports)
```

---

## 9. State Lifecycle Table

What survives each level of reload.

| State                 | Plugin Reload         | Brain Reload          | Process Restart        |
|-----------------------|-----------------------|-----------------------|------------------------|
| Tool registrations    | Re-synced             | Re-synced             | Re-loaded              |
| Event handlers        | Re-registered (per-plugin cleanup via `removePlugin()`) | Lost (`eventBus.clear()` in dispose) | Lost |
| BrainSnapshot         | Preserved (same Brain instance) | Preserved (exported → restored via `restoreFromSnapshot()`) | Lost (unless `statePath` configured — atomic write in `dispose()`) |
| MCP connection        | Preserved             | Preserved             | Lost                   |
| CWD context           | Per-call (`getCwd()` in mcp.ts) | Per-call              | Per-call               |
| Zod schemas           | Re-extracted          | Re-extracted          | Re-extracted           |
| Plugin reloadCount    | Incremented           | Restored from snapshot| Restored from disk (if `statePath`) or 0 |
| Resource registrations| Re-synced             | Re-synced             | Re-loaded              |
| Prompt registrations  | Re-synced             | Re-synced             | Re-loaded              |
| File watchers (plugin)| Preserved (shell owns)| Re-synced via `syncPluginWatchers()` | Lost |
| File watcher (brain)  | Preserved             | Preserved (shell owns)| Lost                   |

**Snapshot persistence** (`statePath` in open-reload.json):
- On `Brain.dispose()`: `writeFileSync(tmpPath, JSON.stringify(snapshot))` then `renameSync(tmpPath, statePath)` — atomic write for crash safety.
- On `factory.create()`: if no in-memory snapshot but `statePath` file exists, reads and restores from disk.

**Plugin error resilience**: When a plugin reload fails, `PluginStateManager.setError()` preserves
`existing.tools` (last-known-good). The router continues to serve stale tools until the next
successful reload.
