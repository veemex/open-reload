import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import type {
  BrainAPI,
  BrainContext,
  BrainFactory,
  BrainInit,
  BrainSnapshot,
  FileEvent,
  FileEventEffects,
  PromptMessage,
  PromptSpec,
  ResourceContent,
  ResourceSpec,
  ToolCall,
  ToolResult,
  ToolSpec,
  WatchPlan,
} from "../shell/brain-api.ts";
import { loadConfig } from "./config/loader.ts";
import type { OpenReloadConfig, PluginConfig, SystemPromptConfig } from "./config/types.ts";
import { PluginEventBus } from "./events/event-bus.ts";
import { loadPluginModule } from "./loader/module-loader.ts";
import { ToolRouter } from "./router/tool-router.ts";
import { PluginStateManager } from "./state/plugin-state.ts";
import { buildWatchPlan, classifyEvents } from "./watcher/policy.ts";

const EMPTY_CONFIG: OpenReloadConfig = { plugins: [], debounceMs: 300, logLevel: "info" };

export function topoSort(plugins: PluginConfig[]): PluginConfig[] {
  const byName = new Map<string, PluginConfig>();
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const plugin of plugins) {
    byName.set(plugin.name, plugin);
    adjacency.set(plugin.name, []);
    inDegree.set(plugin.name, 0);
  }

  for (const plugin of plugins) {
    for (const dependency of plugin.dependsOn ?? []) {
      if (!byName.has(dependency)) {
        throw new Error(`Plugin "${plugin.name}": missing dependency "${dependency}"`);
      }

      adjacency.get(dependency)?.push(plugin.name);
      inDegree.set(plugin.name, (inDegree.get(plugin.name) ?? 0) + 1);
    }
  }

  const queue = plugins
    .filter((plugin) => (inDegree.get(plugin.name) ?? 0) === 0)
    .map((plugin) => plugin.name);
  const sortedNames: string[] = [];

  while (queue.length > 0) {
    const pluginName = queue.shift();
    if (!pluginName) break;

    sortedNames.push(pluginName);
    for (const dependent of adjacency.get(pluginName) ?? []) {
      const nextInDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, nextInDegree);
      if (nextInDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  if (sortedNames.length !== plugins.length) {
    const cycleNodes = plugins
      .map((plugin) => plugin.name)
      .filter((name) => (inDegree.get(name) ?? 0) > 0);
    throw new Error(`Circular dependency detected: ${cycleNodes.join(" -> ")}`);
  }

  return sortedNames.map((name) => byName.get(name)!);
}

function buildDependentsMap(plugins: PluginConfig[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const plugin of plugins) {
    dependents.set(plugin.name, []);
  }

  for (const plugin of plugins) {
    for (const dependency of plugin.dependsOn ?? []) {
      dependents.get(dependency)?.push(plugin.name);
    }
  }

  return dependents;
}

function getReloadOrder(initialPlugins: string[], plugins: PluginConfig[]): string[] {
  if (initialPlugins.length === 0) {
    return [];
  }

  const dependents = buildDependentsMap(plugins);
  const toReload = new Set(initialPlugins);
  const queue = [...initialPlugins];

  while (queue.length > 0) {
    const pluginName = queue.shift();
    if (!pluginName) break;

    for (const dependent of dependents.get(pluginName) ?? []) {
      if (toReload.has(dependent)) {
        continue;
      }
      toReload.add(dependent);
      queue.push(dependent);
    }
  }

  return plugins.map((plugin) => plugin.name).filter((name) => toReload.has(name));
}

class Brain implements BrainAPI {
  private ctx: BrainContext;
  private config: OpenReloadConfig;
  private router: ToolRouter;
  private stateManager: PluginStateManager;
  private watchPlan: WatchPlan;
  private eventBus: PluginEventBus;

  constructor(
    ctx: BrainContext,
    config: OpenReloadConfig,
    router: ToolRouter,
    stateManager: PluginStateManager,
    watchPlan: WatchPlan,
    eventBus: PluginEventBus,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.router = router;
    this.stateManager = stateManager;
    this.watchPlan = watchPlan;
    this.eventBus = eventBus;
  }

  async listTools(): Promise<ToolSpec[]> {
    return this.router.listSpecs();
  }

  async callTool(call: ToolCall): Promise<ToolResult> {
    return this.router.route(call);
  }

  async listResources(): Promise<ResourceSpec[]> {
    return this.stateManager.getAllResources().map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));
  }

  async listPrompts(): Promise<PromptSpec[]> {
    const pluginPrompts: PromptSpec[] = this.stateManager.getAllPrompts().map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    }));

    const systemSpecs = buildSystemPromptSpecs(this.config.systemPrompts);
    return [...systemSpecs, ...pluginPrompts];
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<PromptMessage[]> {
    const systemPrompt = resolveSystemPrompt(name, this.config.systemPrompts);
    if (systemPrompt) {
      return [{ role: "user", content: { type: "text", text: systemPrompt.content } }];
    }

    const prompt = this.stateManager
      .getAllPrompts()
      .find((candidate) => candidate.name === name);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }
    return prompt.get(args);
  }

  async readResource(uri: string): Promise<ResourceContent> {
    const resource = this.stateManager
      .getAllResources()
      .find((candidate) => candidate.uri === uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    const text = await resource.read();
    return {
      uri: resource.uri,
      text,
      mimeType: resource.mimeType,
    };
  }

  async getWatchPlan(): Promise<WatchPlan> {
    return this.watchPlan;
  }

  async onFileEvents(events: FileEvent[]): Promise<FileEventEffects> {
    const effects = classifyEvents(events, this.stateManager.getAllStates());
    const reloadOrder = getReloadOrder(effects.reloadPlugins, this.config.plugins);

    // Reload affected plugins
    for (const pluginName of reloadOrder) {
      const pluginConfig = this.config.plugins.find((p) => p.name === pluginName);
      if (!pluginConfig) continue;

      const oldState = this.stateManager.getState(pluginName);
      this.eventBus.removePlugin(pluginName);
      if (oldState?.dispose) {
        try {
          await oldState.dispose();
        } catch (disposeErr) {
          const disposeMsg = disposeErr instanceof Error ? disposeErr.message : String(disposeErr);
          this.ctx.logErr(`Plugin dispose failed: ${pluginName}: ${disposeMsg}`);
        }
      }

      this.stateManager.setLoading(pluginName, pluginConfig);
      try {
        const loaded = await loadPluginModule(pluginConfig, this.eventBus);
        this.stateManager.setLoaded(
          pluginName,
          pluginConfig,
          loaded.tools,
          loaded.resources ?? [],
          loaded.prompts ?? [],
          loaded.dispose
        );
        this.ctx.logErr(`Plugin reloaded: ${pluginName}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.stateManager.setError(pluginName, pluginConfig, msg);
        this.ctx.logErr(`Plugin reload failed: ${pluginName}: ${msg}`);
      }
    }

    // Rebuild router if any plugins were reloaded
    if (reloadOrder.length > 0) {
      this.router.rebuild(this.stateManager.getAllTools());
    }

    // Return only the standard FileEventEffects (not the extended type)
    return {
      reloadBrain: effects.reloadBrain,
      refreshWatchPlan: effects.refreshWatchPlan,
    };
  }

  async exportSnapshot(): Promise<BrainSnapshot> {
    return this.stateManager.toSnapshot();
  }

  async dispose(): Promise<void> {
    if (this.config.statePath) {
      try {
        const snapshot = this.stateManager.toSnapshot();
        const tmpPath = this.config.statePath + ".tmp";
        writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
        renameSync(tmpPath, this.config.statePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.ctx.logErr(`Failed to save snapshot to disk: ${msg}`);
      }
    }

    this.eventBus.clear();
    for (const state of this.stateManager.getAllStates()) {
      if (state.dispose) {
        try {
          await state.dispose();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.ctx.logErr(`Plugin dispose failed: ${state.config.name}: ${msg}`);
        }
      }
    }
    this.ctx.logErr("Brain disposed");
  }
}

const SYSTEM_PROMPT_PREFIX = "system:";

function buildSystemPromptSpecs(
  systemPrompts: SystemPromptConfig[] | undefined
): PromptSpec[] {
  if (!systemPrompts || systemPrompts.length === 0) return [];

  return systemPrompts
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map((sp) => ({
      name: `${SYSTEM_PROMPT_PREFIX}${sp.name}`,
      description: sp.content.slice(0, 100),
    }));
}

function resolveSystemPrompt(
  name: string,
  systemPrompts: SystemPromptConfig[] | undefined
): SystemPromptConfig | undefined {
  if (!name.startsWith(SYSTEM_PROMPT_PREFIX) || !systemPrompts) return undefined;
  const rawName = name.slice(SYSTEM_PROMPT_PREFIX.length);
  return systemPrompts.find((sp) => sp.name === rawName);
}

export const factory: BrainFactory = {
  async create(ctx: BrainContext, init: BrainInit): Promise<BrainAPI> {
    // 1. Load config (graceful: missing config → empty plugins)
    let config: OpenReloadConfig;
    try {
      config = await loadConfig(init.configPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("No open-reload.json found.")) {
        config = EMPTY_CONFIG;
      } else {
        throw err;
      }
    }

    config = {
      ...config,
      plugins: topoSort(config.plugins),
    };

    // 2. Create state manager, restore from snapshot if present
    const stateManager = new PluginStateManager();
    if (init.snapshot) {
      stateManager.restoreFromSnapshot(init.snapshot);
    } else if (config.statePath && existsSync(config.statePath)) {
      try {
        const data = readFileSync(config.statePath, "utf-8");
        const diskSnapshot = JSON.parse(data) as BrainSnapshot;
        stateManager.restoreFromSnapshot(diskSnapshot);
      } catch {
        ctx.logErr("Failed to load snapshot from disk, starting fresh");
      }
    }

    const eventBus = new PluginEventBus();

    // 3. Load each plugin
    for (const pluginConfig of config.plugins) {
      stateManager.setLoading(pluginConfig.name, pluginConfig);
      try {
        const loaded = await loadPluginModule(pluginConfig, eventBus);
        stateManager.setLoaded(
          pluginConfig.name,
          pluginConfig,
          loaded.tools,
          loaded.resources ?? [],
          loaded.prompts ?? [],
          loaded.dispose
        );
        ctx.logErr(
          `Plugin loaded: ${pluginConfig.name} (${loaded.tools.length} tools, ${(loaded.resources ?? []).length} resources, ${(loaded.prompts ?? []).length} prompts)`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stateManager.setError(pluginConfig.name, pluginConfig, msg);
        ctx.logErr(`Plugin load failed: ${pluginConfig.name}: ${msg}`);
      }
    }

    // 4. Build router from all loaded tools
    const router = new ToolRouter(stateManager.getAllTools());

    // 5. Build watch plan
    const watchPlan = buildWatchPlan(config);

    return new Brain(ctx, config, router, stateManager, watchPlan, eventBus);
  },
};

export default factory;
