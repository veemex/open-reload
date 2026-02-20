import { z } from "zod";
import { loadConfig } from "../brain/config/loader.ts";
import { PluginEventBus } from "../brain/events/event-bus.ts";
import type { OpenReloadConfig } from "../brain/config/types.ts";
import { TrampolineRegistry } from "./trampolines.ts";
import { NativePluginManager, TRAMPOLINE_HOOK_TYPES } from "./manager.ts";
import { RuntimeBridge } from "./runtime-bridge.ts";

function log(msg: string): void {
  process.stderr.write(`[open-reload] ${msg}\n`);
}

export default async function openReloadNative(
  input: unknown,
): Promise<Record<string, unknown>> {
  const inputObj = input as Record<string, unknown> | null;
  const directory = typeof inputObj?.directory === "string" ? inputObj.directory : undefined;
  log(`Starting native mode (directory: ${directory || process.cwd()})`);

  let config: OpenReloadConfig;
  try {
    config = await loadConfig(undefined, directory);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Config error: ${msg}`);
    config = { plugins: [], debounceMs: 300, logLevel: "info" };
  }

  const registry = new TrampolineRegistry();
  const eventBus = new PluginEventBus();
  const manager = new NativePluginManager(config, registry, eventBus, input);

  const loadResults = await manager.loadAll();

  const bridge = new RuntimeBridge(manager, eventBus, config);
  bridge.start();

  const toolMap: Record<string, unknown> = {};

  toolMap["openreload_reload"] = {
    description:
      "Force hot-reload of managed plugins. Specify a plugin name to reload one, or omit to reload all.",
    args: {
      plugin: z
        .string()
        .optional()
        .describe("Plugin name to reload (omit for all)"),
    },
    execute: async (args: { plugin?: string }) => {
      if (args.plugin) {
        await manager.reloadPlugin(args.plugin);
        return `Reloaded plugin: ${args.plugin}`;
      }
      await manager.reloadAll();
      return "Reloaded all plugins";
    },
  };

  toolMap["openreload_status"] = {
    description:
      "Show status of all managed plugins including reload counts, errors, and loaded tools/hooks.",
    args: {},
    execute: async () => {
      const status = manager.getStatus();
      const lines: string[] = ["open-reload native mode\n"];

      for (const [name, state] of Object.entries(status)) {
        lines.push(`[${state.status}] ${name}`);
        lines.push(`  Reloads: ${state.reloadCount}`);
        lines.push(`  Tools: ${state.toolNames.join(", ") || "(none)"}`);
        lines.push(`  Hooks: ${state.hookTypes.join(", ") || "(none)"}`);
        if (state.lastError) lines.push(`  Error: ${state.lastError}`);
        lines.push("");
      }

      return lines.join("\n");
    },
  };

  toolMap["openreload_invoke"] = {
    description:
      "Invoke a dynamically-loaded tool by name. Use for tools from worktree plugin instances that were added after initialization.",
    args: {
      tool: z.string().describe("Qualified tool name to invoke"),
      args: z.string().optional().describe("JSON string of tool arguments"),
      routeKey: z
        .string()
        .optional()
        .describe("Explicit route key for routing (e.g., environment ID)"),
    },
    execute: async (
      invokeArgs: { tool: string; args?: string; routeKey?: string },
      context: unknown,
    ) => {
      let parsedArgs: Record<string, unknown> = {};
      if (invokeArgs.args) {
        try {
          const parsed = JSON.parse(invokeArgs.args);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Parsed args must be a JSON object");
          }
          parsedArgs = parsed as Record<string, unknown>;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Invalid JSON for args: ${msg}`);
        }
      }

      let invokeContext = context;
      if (invokeArgs.routeKey) {
        const routeKeys = registry.getRouteKeys(invokeArgs.tool);
        if (routeKeys.length > 0 && !routeKeys.includes(invokeArgs.routeKey)) {
          throw new Error(
            `Tool "${invokeArgs.tool}" has no route "${invokeArgs.routeKey}". Available routes: ${routeKeys.join(", ")}`,
          );
        }

        const status = manager.getStatus();
        const routeState = Object.values(status).find(
          (state) =>
            state.routeSpec?.routeKey === invokeArgs.routeKey &&
            state.toolNames.includes(invokeArgs.tool),
        );

        const routePrefix = routeState?.routeSpec?.worktreePrefix;
        if (routePrefix) {
          const baseContext =
            context && typeof context === "object"
              ? (context as Record<string, unknown>)
              : {};
          invokeContext = {
            ...baseContext,
            worktree: routePrefix,
            directory: routePrefix,
          };
        }
      }

      try {
        const trampoline = registry.createToolTrampoline(invokeArgs.tool);
        return await trampoline(parsedArgs, invokeContext);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const routes = registry.getRouteKeys(invokeArgs.tool);
        if (routes.length > 0) {
          throw new Error(
            `Failed to invoke tool "${invokeArgs.tool}" (${msg}). Available routes: ${routes.join(", ")}. Provide routeKey or ensure context matches a worktree prefix.`,
          );
        }
        throw new Error(
          `Failed to invoke tool "${invokeArgs.tool}": ${msg}. Available tools can be seen via openreload_status.`,
        );
      }
    },
  };

  for (const [_pluginName, result] of loadResults) {
    for (const [qualifiedName, toolDef] of Object.entries(result.tools)) {
      toolMap[qualifiedName] = {
        description: toolDef.description,
        args: toolDef.args,
        execute: registry.createToolTrampoline(qualifiedName),
      };
    }
  }

  const hookMap: Record<string, unknown> = {};
  for (const hookType of TRAMPOLINE_HOOK_TYPES) {
    hookMap[hookType] = registry.createHookTrampoline(hookType);
  }

  manager.startWatchers(() => {
    log("Reload complete — tool implementations swapped");
  });

  log(
    `Ready: ${Object.keys(toolMap).length} tools, ${Object.keys(hookMap).length} hooks`,
  );

  return {
    tool: toolMap,
    ...hookMap,
    dispose: async () => {
      bridge.stop();
      await manager.dispose();
      log("Disposed");
    },
  };
}
