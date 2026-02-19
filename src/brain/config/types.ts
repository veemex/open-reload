import type { ToolCallContext } from "../../shell/brain-api.ts";

export interface PluginConfig {
  name: string;
  entry: string;
  watchDir?: string;
  /**
   * - "opencode-plugin": default export `(ctx) => ({ tools: { name: tool() } })`
   * - "tool-array": named export `tools = [{ name, description, inputSchema, execute }]`
   * - "mcp-tools": named export `tools = { name: { description, inputSchema, execute } }`
   */
  exportType: "opencode-plugin" | "tool-array" | "mcp-tools";
  prefix?: boolean;
}

export interface OpenReloadConfig {
  plugins: PluginConfig[];
  debounceMs?: number;
  logLevel?: "error" | "warn" | "info" | "debug";
  logFile?: string;
}

export interface PluginState {
  config: PluginConfig;
  tools: ManagedTool[];
  lastReloadAt: number;
  status: "loaded" | "error" | "loading";
  lastError: string | null;
  reloadCount: number;
}

export interface ManagedTool {
  qualifiedName: string;
  originalName: string;
  pluginName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, context?: ToolCallContext) => Promise<string>;
}
