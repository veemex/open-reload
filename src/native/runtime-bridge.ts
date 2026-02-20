import type { NativePluginManager } from "./manager.ts";
import type { PluginEventBus, PluginEvent } from "../brain/events/event-bus.ts";
import type { PluginConfig, OpenReloadConfig } from "../brain/config/types.ts";
import type { RouteSpec } from "./trampolines.ts";

export type OcbEnvironmentCreated = {
  envId: string;
  taskBranch: string;
  profile?: string;
  worktrees: Record<string, string>;
};

export type OcbEnvironmentCleanupRequested = {
  envId: string;
};

function log(message: string): void {
  process.stderr.write(`[open-reload] runtime-bridge: ${message}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class RuntimeBridge {
  private manager: NativePluginManager;
  private eventBus: PluginEventBus;
  private baseConfig: OpenReloadConfig;
  private unsubscribeFns: Array<() => void> = [];
  private started = false;
  private envPlugins = new Map<string, string[]>();

  constructor(
    manager: NativePluginManager,
    eventBus: PluginEventBus,
    baseConfig: OpenReloadConfig,
  ) {
    this.manager = manager;
    this.eventBus = eventBus;
    this.baseConfig = baseConfig;
  }

  start(): void {
    if (this.started) {
      return;
    }

    const unsubscribeCreated = this.eventBus.on(
      "ocb.environment.created",
      (event) => {
        void this.handleEnvironmentCreated(event);
      },
    );

    const unsubscribeCleanup = this.eventBus.on(
      "ocb.environment.cleanup_requested",
      (event) => {
        void this.handleEnvironmentCleanup(event);
      },
    );

    this.unsubscribeFns.push(unsubscribeCreated, unsubscribeCleanup);
    this.started = true;
    log("subscribed to environment lifecycle events");
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribeFns) {
      unsubscribe();
    }
    this.unsubscribeFns = [];
    this.started = false;

    for (const pluginNames of this.envPlugins.values()) {
      for (const pluginName of pluginNames) {
        void this.manager.removePlugin(pluginName).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log(`failed removing plugin during stop: ${pluginName}: ${msg}`);
        });
      }
    }

    this.envPlugins.clear();
    log("stopped and unsubscribed");
  }

  private async handleEnvironmentCreated(event: PluginEvent): Promise<void> {
    const payload = event.payload;
    if (!isRecord(payload)) {
      log("ignored ocb.environment.created: payload is not an object");
      return;
    }

    const envId = typeof payload.envId === "string" ? payload.envId : "";
    const worktrees = payload.worktrees;
    if (!envId || !isRecord(worktrees)) {
      log("ignored ocb.environment.created: missing envId or worktrees");
      return;
    }

    const template = this.baseConfig.plugins.find(
      (plugin) => plugin.exportType === "opencode-plugin",
    );
    if (!template) {
      log(`cannot attach environment ${envId}: no opencode-plugin template found`);
      return;
    }

    const entries = Object.entries(worktrees).filter(
      ([repoKey, pathValue]) =>
        repoKey.length > 0 &&
        typeof pathValue === "string" &&
        pathValue.length > 0,
    ) as Array<[string, string]>;

    if (entries.length === 0) {
      log(`ignored environment ${envId}: no valid worktree entries`);
      return;
    }

    const pluginNames: string[] = [];
    const isMultiRepo = entries.length > 1;

    for (const [repoKey, worktreePath] of entries) {
      const pluginName = isMultiRepo
        ? `ocb@env_${envId}/${repoKey}`
        : `ocb@env_${envId}`;

      const config: PluginConfig = {
        name: pluginName,
        entry: template.entry,
        watchDir: worktreePath,
        exportType: template.exportType,
        prefix: template.prefix,
        namespace: template.namespace,
        agentVisibility: template.agentVisibility,
        worktreePath,
      };

      const routeSpec: RouteSpec = {
        routeKey: envId,
        worktreePrefix: worktreePath,
      };

      try {
        await this.manager.addPlugin(config, routeSpec);
        pluginNames.push(pluginName);
        log(`attached ${pluginName} for ${repoKey} (${worktreePath})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`failed attaching ${pluginName} for ${repoKey}: ${msg}`);
      }
    }

    if (pluginNames.length > 0) {
      this.envPlugins.set(envId, pluginNames);
      log(`environment ${envId} attached (${pluginNames.length} plugin(s))`);
      return;
    }

    log(`environment ${envId} attach had no successful plugin loads`);
  }

  private async handleEnvironmentCleanup(event: PluginEvent): Promise<void> {
    const payload = event.payload;
    if (!isRecord(payload)) {
      log("ignored ocb.environment.cleanup_requested: payload is not an object");
      return;
    }

    const envId = typeof payload.envId === "string" ? payload.envId : "";
    if (!envId) {
      log("ignored ocb.environment.cleanup_requested: missing envId");
      return;
    }

    const pluginNames = this.envPlugins.get(envId) ?? [];
    if (pluginNames.length === 0) {
      this.envPlugins.delete(envId);
      log(`cleanup requested for ${envId}, no tracked plugins`);
      return;
    }

    for (const pluginName of pluginNames) {
      try {
        await this.manager.removePlugin(pluginName);
        log(`removed plugin ${pluginName}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`failed removing plugin ${pluginName}: ${msg}`);
      }
    }

    this.envPlugins.delete(envId);
    log(`environment ${envId} cleanup handled`);
  }
}
