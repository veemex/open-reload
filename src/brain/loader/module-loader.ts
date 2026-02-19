import { readdirSync, statSync, existsSync } from "fs";
import { join, dirname, relative } from "path";
import type {
  PluginConfig,
  ManagedPrompt,
  ManagedResource,
  ManagedTool,
  PluginLoadResult,
} from "../config/types.ts";
import type { EventHandler, PluginEventBus } from "../events/event-bus.ts";
import type { PromptMessage, ToolCallContext } from "../../shell/brain-api.ts";

function qualifyName(config: PluginConfig, toolName: string): string {
  if (config.prefix === false) return toolName;
  return `${config.name}_${toolName}`;
}

export function resolveEffectiveEntry(config: PluginConfig): string {
  if (!config.worktreePath) return config.entry;
  const watchDir = config.watchDir ?? dirname(config.entry);
  const relativeEntry = relative(watchDir, config.entry);
  return join(config.worktreePath, relativeEntry);
}

export async function loadPluginModule(
  config: PluginConfig,
  eventBus?: PluginEventBus
): Promise<PluginLoadResult> {
  const effectiveEntry = resolveEffectiveEntry(config);
  const importPath = `${effectiveEntry}?t=${Date.now()}`;

  try {
    purgePluginModules(config);
  } catch {
    try {
      clearBunCache(effectiveEntry);
    } catch {}
  }

  const mod = await import(importPath);
  return await extractTools(config, mod, eventBus);
}

function collectModulePaths(dir: string): string[] {
  const paths: string[] = [];
  if (!existsSync(dir)) return paths;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      paths.push(...collectModulePaths(full));
    } else if (/\.(ts|js|mts|mjs)$/.test(entry)) {
      paths.push(full);
    }
  }
  return paths;
}

function purgePluginModules(config: PluginConfig): void {
  const loader = (globalThis as Record<string, unknown>).Loader as
    | Record<string, unknown>
    | undefined;
  const registry = loader?.registry as
    | { delete?: (path: string) => void }
    | undefined;
  if (!registry?.delete) return;

  const dir = config.worktreePath ?? config.watchDir ?? config.entry;
  for (const modulePath of collectModulePaths(dir)) {
    registry.delete(modulePath);
  }
}

function clearBunCache(absolutePath: string): void {
  const loader = (globalThis as Record<string, unknown>).Loader as
    | Record<string, unknown>
    | undefined;
  const registry = loader?.registry as
    | { delete?: (path: string) => void }
    | undefined;
  if (registry?.delete) {
    registry.delete(absolutePath);
  }
}

async function extractTools(
  config: PluginConfig,
  mod: Record<string, unknown>,
  eventBus?: PluginEventBus
): Promise<PluginLoadResult> {
  switch (config.exportType) {
    case "opencode-plugin":
      return extractFromOpenCodePlugin(config, mod, eventBus);
    case "tool-array":
      return { tools: await extractFromToolArray(config, mod) };
    case "mcp-tools":
      return { tools: await extractFromMcpTools(config, mod) };
    default:
      throw new Error(
        `Unknown exportType "${config.exportType}" for plugin "${config.name}"`
      );
  }
}

async function extractFromOpenCodePlugin(
  config: PluginConfig,
  mod: Record<string, unknown>,
  eventBus?: PluginEventBus
): Promise<PluginLoadResult> {
  const pluginFn =
    typeof mod.default === "function"
      ? (mod.default as (input: Record<string, unknown>) => unknown)
      : undefined;
  if (!pluginFn) {
    throw new Error(
      `Plugin "${config.name}": expected default export to be a function (opencode-plugin format)`
    );
  }

  const cwd = process.cwd();
  const stubInput = {
    directory: cwd,
    worktree: cwd,
  };
  const result = await pluginFn(stubInput);

  const resultObj =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : undefined;

  const disposeFn =
    typeof resultObj?.dispose === "function"
      ? (resultObj.dispose as () => Promise<void>)
      : undefined;

  const toolMap =
    (resultObj?.tool as Record<string, unknown> | undefined) ??
    (resultObj?.tools as Record<string, unknown> | undefined);
  if (!toolMap || typeof toolMap !== "object" || Array.isArray(toolMap)) {
    throw new Error(
      `Plugin "${config.name}": plugin function must return { tool: { ... } }`
    );
  }

  const tools: ManagedTool[] = [];
  for (const [name, toolDef] of Object.entries(toolMap)) {
    const def = toolDef as Record<string, unknown>;

    let inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    let zodInputSchema: unknown | undefined;
    if (def.args && typeof def.args === "object") {
      try {
        const { z } = await import("zod");
        const zodObjectSchema = z.object(def.args as Record<string, unknown>);
        zodInputSchema = zodObjectSchema;
        const jsonSchema = z.toJSONSchema(zodObjectSchema);
        inputSchema = jsonSchema as Record<string, unknown>;
      } catch {
        inputSchema = { type: "object", properties: {} };
      }
    } else if (def.schema && typeof def.schema === "object") {
      inputSchema = def.schema as Record<string, unknown>;
    }

    const originalExecute = def.execute as
      | ((args: Record<string, unknown>, context: unknown) => Promise<string>)
      | undefined;
    if (typeof originalExecute !== "function") {
      throw new Error(
        `Plugin "${config.name}" tool "${name}": missing execute function`
      );
    }

    tools.push({
      qualifiedName: qualifyName(config, name),
      originalName: name,
      pluginName: config.name,
      description: (def.description as string) || "",
      inputSchema,
      zodInputSchema,
      execute: async (input: Record<string, unknown>, ctx?: ToolCallContext): Promise<string> => {
        const execContext = {
          sessionID: ctx?.sessionId ?? "open-reload",
          messageID: "open-reload",
          agent: ctx?.agentId ?? "open-reload",
          directory: ctx?.cwd ?? cwd,
          worktree: ctx?.cwd ?? cwd,
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {
            process.stderr.write(
              `[open-reload] Plugin "${config.name}" tool "${name}" called ask() -- not supported in open-reload context\n`
            );
          },
          events: eventBus
            ? {
                emit: (type: string, payload: unknown) =>
                  eventBus.emit({
                    source: config.name,
                    type,
                    payload,
                    timestamp: Date.now(),
                  }),
                on: (type: string, handler: EventHandler) => eventBus.on(type, handler, config.name),
              }
            : undefined,
        };
        return originalExecute(input, execContext);
      },
    });
  }

  const resourceMap = resultObj?.resource as Record<string, unknown> | undefined;
  const resources: ManagedResource[] = [];
  if (resourceMap && typeof resourceMap === "object" && !Array.isArray(resourceMap)) {
    for (const [name, resourceDef] of Object.entries(resourceMap)) {
      const def = resourceDef as Record<string, unknown>;
      const readFn = def.read as (() => Promise<string>) | undefined;
      if (typeof readFn !== "function") {
        throw new Error(
          `Plugin "${config.name}" resource "${name}": missing read function`
        );
      }

      resources.push({
        uri: name,
        name,
        pluginName: config.name,
        description: typeof def.description === "string" ? def.description : undefined,
        mimeType: typeof def.mimeType === "string" ? def.mimeType : undefined,
        read: async (): Promise<string> => readFn(),
      });
    }
  }

  const promptMap = resultObj?.prompt as Record<string, unknown> | undefined;
  const prompts: ManagedPrompt[] = [];
  if (promptMap && typeof promptMap === "object" && !Array.isArray(promptMap)) {
    for (const [name, promptDef] of Object.entries(promptMap)) {
      const def = promptDef as Record<string, unknown>;
      const getFn = def.get as ((args?: Record<string, string>) => Promise<PromptMessage[]>) | undefined;
      if (typeof getFn !== "function") {
        throw new Error(
          `Plugin "${config.name}" prompt "${name}": missing get function`
        );
      }

      prompts.push({
        name,
        pluginName: config.name,
        description: typeof def.description === "string" ? def.description : undefined,
        arguments: Array.isArray(def.arguments) ? (def.arguments as ManagedPrompt["arguments"]) : undefined,
        get: async (args?: Record<string, string>): Promise<PromptMessage[]> => getFn(args),
      });
    }
  }

  return { tools, resources, prompts, dispose: disposeFn };
}

async function extractFromToolArray(
  config: PluginConfig,
  mod: Record<string, unknown>
): Promise<ManagedTool[]> {
  const arr = mod.tools;
  if (!Array.isArray(arr)) {
    throw new Error(
      `Plugin "${config.name}": expected "tools" export to be an array (tool-array format)`
    );
  }

  const { z } = await import("zod");
  return arr.map((tool: Record<string, unknown>) => {
    const originalExecute = tool.execute as ManagedTool["execute"];
    let zodInputSchema: unknown | undefined;
    if (tool.inputSchema) {
      try {
        zodInputSchema = z.fromJSONSchema(tool.inputSchema as Record<string, unknown>);
      } catch {}
    }

    return {
      qualifiedName: qualifyName(config, tool.name as string),
      originalName: tool.name as string,
      pluginName: config.name,
      description: (tool.description as string) || "",
      inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
      zodInputSchema,
      execute: async (input: Record<string, unknown>, context?: ToolCallContext): Promise<string> => {
        return originalExecute(input, context);
      },
    };
  });
}

async function extractFromMcpTools(
  config: PluginConfig,
  mod: Record<string, unknown>
): Promise<ManagedTool[]> {
  const obj = mod.tools;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(
      `Plugin "${config.name}": expected "tools" export to be an object (mcp-tools format)`
    );
  }

  const tools: ManagedTool[] = [];
  for (const [name, def] of Object.entries(
    obj as Record<string, Record<string, unknown>>
  )) {
    const originalExecute = def.execute as ManagedTool["execute"];
    let zodInputSchema: unknown | undefined;
    if (def.inputSchema) {
      try {
        const { z } = await import("zod");
        zodInputSchema = z.fromJSONSchema(def.inputSchema as Record<string, unknown>);
      } catch {}
    }

    tools.push({
      qualifiedName: qualifyName(config, name),
      originalName: name,
      pluginName: config.name,
      description: (def.description as string) || "",
      inputSchema: (def.inputSchema as Record<string, unknown>) || {},
      zodInputSchema,
      execute: async (input: Record<string, unknown>, context?: ToolCallContext): Promise<string> => {
        return originalExecute(input, context);
      },
    });
  }

  return tools;
}
