import type { PluginConfig, ManagedTool } from "../config/types.ts";

export async function loadPluginModule(
  config: PluginConfig
): Promise<ManagedTool[]> {
  const importPath = `${config.entry}?t=${Date.now()}`;

  try {
    clearBunCache(config.entry);
  } catch {
    // Query string cache bust is sufficient as fallback
  }

  const mod = await import(importPath);
  return extractTools(config, mod);
}

// Bun's Loader.registry is undocumented — cache eviction before re-import
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

function extractTools(
  config: PluginConfig,
  mod: Record<string, unknown>
): ManagedTool[] {
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

function extractFromOpenCodePlugin(
  config: PluginConfig,
  mod: Record<string, unknown>
): ManagedTool[] {
  const pluginFn =
    typeof mod.default === "function" ? mod.default : undefined;
  if (!pluginFn) {
    throw new Error(
      `Plugin "${config.name}": expected default export to be a function (opencode-plugin format)`
    );
  }

  const result = pluginFn({});
  if (!result?.tools || typeof result.tools !== "object") {
    throw new Error(
      `Plugin "${config.name}": plugin function must return { tools: { ... } }`
    );
  }

  const tools: ManagedTool[] = [];
  for (const [name, toolDef] of Object.entries(result.tools)) {
    const def = toolDef as Record<string, unknown>;
    tools.push({
      qualifiedName: `${config.name}_${name}`,
      originalName: name,
      pluginName: config.name,
      description: (def.description as string) || "",
      inputSchema: (def.schema as Record<string, unknown>) || {},
      execute: def.execute as ManagedTool["execute"],
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
    qualifiedName: `${config.name}_${tool.name as string}`,
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
      qualifiedName: `${config.name}_${name}`,
      originalName: name,
      pluginName: config.name,
      description: (def.description as string) || "",
      inputSchema: (def.inputSchema as Record<string, unknown>) || {},
      execute: def.execute as ManagedTool["execute"],
    });
  }

  return tools;
}
