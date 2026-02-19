import type {
  BrainAPI,
  BrainContext,
  BrainFactory,
  BrainInit,
  BrainSnapshot,
  FileEvent,
  FileEventEffects,
  ResourceContent,
  ResourceSpec,
  ToolCall,
  ToolResult,
  ToolSpec,
  WatchPlan,
} from "../shell/brain-api.ts";
import { loadConfig } from "./config/loader.ts";
import type { OpenReloadConfig } from "./config/types.ts";
import { PluginEventBus } from "./events/event-bus.ts";
import { loadPluginModule } from "./loader/module-loader.ts";
import { ToolRouter } from "./router/tool-router.ts";
import { PluginStateManager } from "./state/plugin-state.ts";
import { buildWatchPlan, classifyEvents } from "./watcher/policy.ts";

const EMPTY_CONFIG: OpenReloadConfig = { plugins: [], debounceMs: 300, logLevel: "info" };

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

    // Reload affected plugins
    for (const pluginName of effects.reloadPlugins) {
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
    if (effects.reloadPlugins.length > 0) {
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

export const factory: BrainFactory = {
  async create(ctx: BrainContext, init: BrainInit): Promise<BrainAPI> {
    // 1. Load config (graceful: missing config → empty plugins)
    let config: OpenReloadConfig;
    try {
      config = await loadConfig(init.configPath);
    } catch {
      config = EMPTY_CONFIG;
    }

    // 2. Create state manager, restore from snapshot if present
    const stateManager = new PluginStateManager();
    if (init.snapshot) {
      stateManager.restoreFromSnapshot(init.snapshot);
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
          loaded.dispose
        );
        ctx.logErr(
          `Plugin loaded: ${pluginConfig.name} (${loaded.tools.length} tools, ${(loaded.resources ?? []).length} resources)`
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
