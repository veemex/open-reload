import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import type { PluginConfig, ManagedTool } from "../config/types.ts";

function qualifyName(config: PluginConfig, toolName: string): string {
  if (config.prefix === false) return toolName;
  return `${config.name}_${toolName}`;
}

export async function loadPluginModule(
  config: PluginConfig
): Promise<ManagedTool[]> {
  const importPath = `${config.entry}?t=${Date.now()}`;

  try {
    purgePluginModules(config);
  } catch {
    try {
      clearBunCache(config.entry);
    } catch {}
  }

  const mod = await import(importPath);
  return await extractTools(config, mod);
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

  const dir = config.watchDir ?? config.entry;
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
  mod: Record<string, unknown>
): Promise<ManagedTool[]> {
  switch (config.exportType) {
    case "opencode-plugin":
      return extractFromOpenCodePlugin(config, mod);
    case "tool-array":
      return extractFromToolArray(config, mod);
    case "mcp-tools":
      return extractFromMcpTools(config, mod);
    default:
      throw new Error(
        `Unknown exportType "${config.exportType}" for plugin "${config.name}"`
      );
  }
}

async function extractFromOpenCodePlugin(
  config: PluginConfig,
  mod: Record<string, unknown>
): Promise<ManagedTool[]> {
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
    if (def.args && typeof def.args === "object") {
      try {
        const { z } = await import("zod");
        const zodObj = z.object(def.args as Record<string, unknown>);
        const jsonSchema = z.toJSONSchema(zodObj);
        inputSchema = jsonSchema as Record<string, unknown>;
      } catch {
        inputSchema = { type: "object", properties: {} };
      }
    } else if (def.schema && typeof def.schema === "object") {
      inputSchema = def.schema as Record<string, unknown>;
    }

    const stubContext = {
      sessionID: "open-reload",
      messageID: "open-reload",
      agent: "open-reload",
      directory: cwd,
      worktree: cwd,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {
        process.stderr.write(
          `[open-reload] Plugin "${config.name}" tool "${name}" called ask() -- not supported in open-reload context\n`
        );
      },
    };

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
      execute: async (input: Record<string, unknown>): Promise<string> => {
        return originalExecute(input, stubContext);
      },
    });
  }

  return tools;
}

function extractFromToolArray(
  config: PluginConfig,
  mod: Record<string, unknown>
): ManagedTool[] {
  const arr = mod.tools;
  if (!Array.isArray(arr)) {
    throw new Error(
      `Plugin "${config.name}": expected "tools" export to be an array (tool-array format)`
    );
  }

  return arr.map((tool: Record<string, unknown>) => ({
    qualifiedName: qualifyName(config, tool.name as string),
    originalName: tool.name as string,
    pluginName: config.name,
    description: (tool.description as string) || "",
    inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
    execute: tool.execute as ManagedTool["execute"],
  }));
}

function extractFromMcpTools(
  config: PluginConfig,
  mod: Record<string, unknown>
): ManagedTool[] {
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
    tools.push({
      qualifiedName: qualifyName(config, name),
      originalName: name,
      pluginName: config.name,
      description: (def.description as string) || "",
      inputSchema: (def.inputSchema as Record<string, unknown>) || {},
      execute: def.execute as ManagedTool["execute"],
    });
  }

  return tools;
}
