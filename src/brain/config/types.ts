import type { PromptMessage, ToolCallContext } from "../../shell/brain-api.ts";

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
  /**
   * Worktree root directory. When set, the plugin is loaded from the worktree
   * instead of the parent repo. The relative path from watchDir to entry is
   * preserved and resolved against this directory.
   *
   * Example: entry="/repos/foo/src/index.ts", watchDir="/repos/foo/src",
   * worktreePath="/worktrees/env_123/foo/src"
   * → effective entry = "/worktrees/env_123/foo/src/index.ts"
   */
  worktreePath?: string;
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
  resources: ManagedResource[];
  prompts: ManagedPrompt[];
  lastReloadAt: number;
  status: "loaded" | "error" | "loading";
  lastError: string | null;
  reloadCount: number;
  dispose?: () => Promise<void>;
}

export interface PluginLoadResult {
  tools: ManagedTool[];
  resources?: ManagedResource[];
  prompts?: ManagedPrompt[];
  dispose?: () => Promise<void>;
}

export interface ManagedTool {
  qualifiedName: string;
  originalName: string;
  pluginName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  zodInputSchema?: unknown;
  execute: (input: Record<string, unknown>, context?: ToolCallContext) => Promise<string>;
}

export interface ManagedResource {
  uri: string;
  name: string;
  pluginName: string;
  description?: string;
  mimeType?: string;
  read: () => Promise<string>;
}

export interface ManagedPrompt {
  name: string;
  pluginName: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  get: (args?: Record<string, string>) => Promise<PromptMessage[]>;
}
