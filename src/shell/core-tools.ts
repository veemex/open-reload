import type { ToolSpec, ToolResult } from "./brain-api.ts";

export const CORE_TOOL_NAMES = ["openreload_reload", "openreload_status"] as const;

export function getCoreToolSpecs(): ToolSpec[] {
  return [
    {
      name: "openreload_reload",
      description: "Force brain reload. Works even if brain is in error state.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "openreload_status",
      description: "Report brain version, last reload time, last error, and loaded plugin count.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
}

export function isCoreToolCall(name: string): boolean {
  return (CORE_TOOL_NAMES as readonly string[]).includes(name);
}

export type ShellStatus = {
  brainLoaded: boolean;
  lastReloadAt: number | null;
  lastError: string | null;
  reloadCount: number;
  pluginCount: number;
};

export function handleStatusCall(status: ShellStatus): ToolResult {
  const lines = [
    `Brain loaded: ${status.brainLoaded}`,
    `Last reload: ${status.lastReloadAt ? new Date(status.lastReloadAt).toISOString() : "never"}`,
    `Reload count: ${status.reloadCount}`,
    `Last error: ${status.lastError ?? "none"}`,
    `Plugins: ${status.pluginCount}`,
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
