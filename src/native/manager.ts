import type { PluginConfig, OpenReloadConfig } from "../brain/config/types.ts";
import {
  resolveEffectiveEntry,
  bustModuleCache,
  qualifyName,
} from "../brain/loader/module-loader.ts";
import { PluginEventBus, type EventHandler } from "../brain/events/event-bus.ts";
import { topoSort } from "../brain/entry.ts";
import { FileWatcher } from "../shell/watch-driver.ts";
import type {
  TrampolineRegistry,
  ToolExecuteFn,
  HookFn,
  RouteSpec,
} from "./trampolines.ts";

const NON_HOOK_KEYS = new Set([
  "tool", "tools", "resource", "prompt", "dispose", "auth",
]);

export const TRAMPOLINE_HOOK_TYPES = [
  "event",
  "config",
  "chat.message",
  "chat.params",
  "chat.headers",
  "permission.ask",
  "command.execute.before",
  "tool.execute.before",
  "tool.execute.after",
  "shell.env",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "experimental.text.complete",
] as const;

export type NativeToolDef = {
  description: string;
  args: Record<string, unknown>;
  execute: ToolExecuteFn;
};

export type NativePluginState = {
  config: PluginConfig;
  status: "loaded" | "error" | "loading";
  lastReloadAt: number;
  reloadCount: number;
  lastError: string | null;
  toolNames: string[];
  hookTypes: string[];
  dispose?: () => Promise<void>;
  routeSpec?: RouteSpec;
};

export type NativeLoadResult = {
  tools: Record<string, NativeToolDef>;
  hooks: Record<string, HookFn>;
  dispose?: () => Promise<void>;
};

function log(msg: string): void {
  process.stderr.write(`[open-reload] ${msg}\n`);
}

export class NativePluginManager {
  private config: OpenReloadConfig;
  private registry: TrampolineRegistry;
  private eventBus: PluginEventBus;
  private pluginInput: unknown;
  private states = new Map<string, NativePluginState>();
  private watchers: FileWatcher[] = [];
  private pluginWatchers = new Map<string, FileWatcher>();
  private onReloadCallback?: () => void;

  constructor(
    config: OpenReloadConfig,
    registry: TrampolineRegistry,
    eventBus: PluginEventBus,
    pluginInput: unknown,
  ) {
    this.config = config;
    this.registry = registry;
    this.eventBus = eventBus;
    this.pluginInput = pluginInput;
  }

  async loadAll(): Promise<Map<string, NativeLoadResult>> {
    const sorted = topoSort(this.config.plugins);
    const results = new Map<string, NativeLoadResult>();

    for (const pluginConfig of sorted) {
      if (pluginConfig.exportType !== "opencode-plugin") {
        log(
          `Skipping "${pluginConfig.name}": native mode only supports opencode-plugin format (got "${pluginConfig.exportType}")`,
        );
        continue;
      }

      this.states.set(pluginConfig.name, {
        config: pluginConfig,
        status: "loading",
        lastReloadAt: Date.now(),
        reloadCount: 0,
        lastError: null,
        toolNames: [],
        hookTypes: [],
      });

      try {
        const result = await this.loadPlugin(pluginConfig);
        this.registerPluginResult(pluginConfig.name, result);
        results.set(pluginConfig.name, result);

        const state = this.states.get(pluginConfig.name)!;
        state.status = "loaded";
        state.toolNames = Object.keys(result.tools);
        state.hookTypes = Object.keys(result.hooks);
        state.dispose = result.dispose;

        log(
          `Plugin loaded: ${pluginConfig.name} (${state.toolNames.length} tools, ${state.hookTypes.length} hooks)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const state = this.states.get(pluginConfig.name)!;
        state.status = "error";
        state.lastError = msg;
        log(`Plugin load failed: ${pluginConfig.name}: ${msg}`);
      }
    }

    return results;
  }

  private async loadPlugin(config: PluginConfig): Promise<NativeLoadResult> {
    const effectiveEntry = resolveEffectiveEntry(config);
    bustModuleCache(config);

    const importPath = `${effectiveEntry}?t=${Date.now()}`;
    const mod = await import(importPath);

    const pluginFn =
      typeof mod.default === "function" ? mod.default : undefined;
    if (!pluginFn) {
      throw new Error(
        `Plugin "${config.name}": expected default export to be a function`,
      );
    }

    const result = await pluginFn(this.pluginInput);
    if (!result || typeof result !== "object") {
      throw new Error(
        `Plugin "${config.name}": plugin function must return an object`,
      );
    }

    const resultObj = result as Record<string, unknown>;

    const rawTools = (resultObj.tool ?? resultObj.tools) as
      | Record<string, Record<string, unknown>>
      | undefined;
    const tools: Record<string, NativeToolDef> = {};

    if (rawTools && typeof rawTools === "object" && !Array.isArray(rawTools)) {
      for (const [name, def] of Object.entries(rawTools)) {
        const qualifiedName = qualifyName(config, name);
        const originalExecute = def.execute as ToolExecuteFn;
        if (typeof originalExecute !== "function") {
          throw new Error(
            `Plugin "${config.name}" tool "${name}": missing execute function`,
          );
        }

        const execute: ToolExecuteFn = async (args, context) => {
          const baseContext =
            context && typeof context === "object"
              ? (context as Record<string, unknown>)
              : {};
          const enrichedContext = {
            ...baseContext,
            events: {
              emit: (type: string, payload: unknown) =>
                this.eventBus.emit({
                  source: config.name,
                  type,
                  payload,
                  timestamp: Date.now(),
                }),
              on: (type: string, handler: EventHandler) =>
                this.eventBus.on(type, handler, config.name),
            },
          };

          return originalExecute(args, enrichedContext);
        };

        tools[qualifiedName] = {
          description: (def.description as string) || "",
          args: (def.args as Record<string, unknown>) || {},
          execute,
        };
      }
    }

    const hooks: Record<string, HookFn> = {};
    for (const [key, value] of Object.entries(resultObj)) {
      if (NON_HOOK_KEYS.has(key)) continue;
      if (typeof value === "function") {
        hooks[key] = value as HookFn;
      }
    }

    const dispose =
      typeof resultObj.dispose === "function"
        ? (resultObj.dispose as () => Promise<void>)
        : undefined;

    return { tools, hooks, dispose };
  }

  private registerPluginResult(
    pluginName: string,
    result: NativeLoadResult,
    routeSpec?: RouteSpec,
  ): void {
    for (const [qualifiedName, tool] of Object.entries(result.tools)) {
      if (routeSpec) {
        this.registry.registerRoute(
          qualifiedName,
          routeSpec.routeKey,
          tool.execute,
          routeSpec,
        );
        continue;
      }
      this.registry.setToolBacking(qualifiedName, tool.execute);
    }

    for (const [hookType, hookFn] of Object.entries(result.hooks)) {
      this.registry.addHookEntry(hookType, pluginName, hookFn);
    }
  }

  private unregisterPluginBindings(state: NativePluginState): void {
    for (const toolName of state.toolNames) {
      if (state.routeSpec) {
        this.registry.unregisterRoute(toolName, state.routeSpec.routeKey);
        continue;
      }
      this.registry.removeToolBacking(toolName);
    }
    this.registry.removePluginHooks(state.config.name);
  }

  async addPlugin(
    config: PluginConfig,
    routeSpec?: RouteSpec,
  ): Promise<NativeLoadResult> {
    if (config.exportType !== "opencode-plugin") {
      throw new Error(
        `Native mode only supports opencode-plugin format (got "${config.exportType}")`,
      );
    }

    if (this.states.has(config.name)) {
      throw new Error(`Plugin already loaded: ${config.name}`);
    }

    this.states.set(config.name, {
      config,
      status: "loading",
      lastReloadAt: Date.now(),
      reloadCount: 0,
      lastError: null,
      toolNames: [],
      hookTypes: [],
      routeSpec,
    });

    try {
      const result = await this.loadPlugin(config);
      this.registerPluginResult(config.name, result, routeSpec);

      const state = this.states.get(config.name)!;
      state.status = "loaded";
      state.toolNames = Object.keys(result.tools);
      state.hookTypes = Object.keys(result.hooks);
      state.dispose = result.dispose;
      state.routeSpec = routeSpec;

      if (config.watchDir) {
        const debounceMs = this.config.debounceMs ?? 300;
        const watcher = new FileWatcher({
          watchDir: config.watchDir,
          debounceMs,
          onChange: () => {
            this.reloadPlugin(config.name).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              log(`Watcher reload error for ${config.name}: ${msg}`);
            });
          },
        });
        watcher.start();
        this.pluginWatchers.set(config.name, watcher);
        log(`Watching dynamic plugin: ${config.watchDir} (${config.name})`);
      }

      log(
        `Plugin loaded: ${config.name} (${state.toolNames.length} tools, ${state.hookTypes.length} hooks)`,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const state = this.states.get(config.name);
      if (state) {
        state.status = "error";
        state.lastError = msg;
      }
      throw err;
    }
  }

  async removePlugin(name: string): Promise<void> {
    const state = this.states.get(name);
    if (!state) {
      return;
    }

    this.eventBus.removePlugin(name);

    if (state.dispose) {
      try {
        await state.dispose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Plugin dispose failed: ${name}: ${msg}`);
      }
    }

    this.unregisterPluginBindings(state);

    const watcher = this.pluginWatchers.get(name);
    if (watcher) {
      watcher.stop();
      this.pluginWatchers.delete(name);
    }

    this.states.delete(name);
  }

  async reloadPlugin(name: string): Promise<void> {
    const state = this.states.get(name);
    if (!state) {
      log(`Cannot reload unknown plugin: ${name}`);
      return;
    }

    this.eventBus.removePlugin(name);
    if (state.dispose) {
      try {
        await state.dispose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Plugin dispose failed: ${name}: ${msg}`);
      }
    }

    this.unregisterPluginBindings(state);

    state.status = "loading";
    state.lastError = null;

    try {
      const result = await this.loadPlugin(state.config);
      this.registerPluginResult(name, result, state.routeSpec);
      state.status = "loaded";
      state.lastReloadAt = Date.now();
      state.reloadCount++;
      state.toolNames = Object.keys(result.tools);
      state.hookTypes = Object.keys(result.hooks);
      state.dispose = result.dispose;

      log(`Plugin reloaded: ${name} (reload #${state.reloadCount})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.status = "error";
      state.lastError = msg;
      log(`Plugin reload failed: ${name}: ${msg}`);
    }

    const dependents = this.getDependents(name);
    for (const dep of dependents) {
      await this.reloadPlugin(dep);
    }

    this.onReloadCallback?.();
  }

  async reloadAll(): Promise<void> {
    const sorted = topoSort(this.config.plugins);
    for (const config of sorted) {
      if (this.states.has(config.name)) {
        await this.reloadPlugin(config.name);
      }
    }
  }

  private getDependents(pluginName: string): string[] {
    return this.config.plugins
      .filter((p) => p.dependsOn?.includes(pluginName))
      .map((p) => p.name);
  }

  startWatchers(onReload: () => void): void {
    this.onReloadCallback = onReload;
    const debounceMs = this.config.debounceMs ?? 300;

    const watchDirs = new Map<string, string[]>();
    for (const config of this.config.plugins) {
      if (config.exportType !== "opencode-plugin") continue;
      const dir = config.watchDir ?? config.entry;
      const plugins = watchDirs.get(dir) ?? [];
      plugins.push(config.name);
      watchDirs.set(dir, plugins);
    }

    for (const [dir, pluginNames] of watchDirs) {
      const watcher = new FileWatcher({
        watchDir: dir,
        debounceMs,
        onChange: () => {
          for (const name of pluginNames) {
            this.reloadPlugin(name).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              log(`Watcher reload error for ${name}: ${msg}`);
            });
          }
        },
      });
      watcher.start();
      this.watchers.push(watcher);
      log(`Watching: ${dir} (plugins: ${pluginNames.join(", ")})`);
    }
  }

  stopWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.stop();
    }
    this.watchers = [];
  }

  getStatus(): Record<string, NativePluginState> {
    const result: Record<string, NativePluginState> = {};
    for (const [name, state] of this.states) {
      result[name] = { ...state };
    }
    return result;
  }

  getState(name: string): NativePluginState | undefined {
    return this.states.get(name);
  }

  async dispose(): Promise<void> {
    this.stopWatchers();
    for (const watcher of this.pluginWatchers.values()) {
      watcher.stop();
    }
    this.pluginWatchers.clear();
    for (const [name, state] of this.states) {
      this.eventBus.removePlugin(name);
      if (state.dispose) {
        try {
          await state.dispose();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Plugin dispose failed on shutdown: ${name}: ${msg}`);
        }
      }
    }
    this.states.clear();
    this.registry.clear();
    this.eventBus.clear();
  }
}
