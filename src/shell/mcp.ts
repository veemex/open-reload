import type { BrainAPI, ToolSpec } from "./brain-api.ts";
import { getCoreToolSpecs, isCoreToolCall, handleStatusCall, type ShellStatus } from "./core-tools.ts";

export async function startMcpServer(_opts: {
  getActiveBrain: () => BrainAPI | null;
  onReloadRequest: () => Promise<void>;
  getStatus: () => ShellStatus;
}): Promise<void> {
  throw new Error("Not implemented yet — see TODO.md Phase 0-4");
}

export function mergeToolLists(
  coreTools: ToolSpec[],
  brainTools: ToolSpec[]
): ToolSpec[] {
  return [...coreTools, ...brainTools];
}
