import type { BrainAPI, BrainContext } from "./brain-api.ts";
import { swapBrain } from "./brain-loader.ts";
import type { ShellStatus } from "./core-tools.ts";

export async function main(): Promise<void> {
  const ctx: BrainContext = {
    cwd: process.cwd(),
    nowMs: () => Date.now(),
    logErr: (line) => process.stderr.write(line + "\n"),
  };

  let activeBrain: BrainAPI | null = null;
  let reloadCount = 0;
  let lastReloadAt: number | null = null;
  let lastError: string | null = null;

  const reload = async () => {
    try {
      activeBrain = await swapBrain(ctx, activeBrain);
      reloadCount++;
      lastReloadAt = Date.now();
      lastError = null;
      ctx.logErr(`Brain reloaded (#${reloadCount})`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      ctx.logErr(`Brain reload failed: ${lastError}`);
    }
  };

  const _getStatus = (): ShellStatus => ({
    brainLoaded: activeBrain !== null,
    lastReloadAt,
    lastError,
    reloadCount,
    pluginCount: 0,
  });

  await reload();

  // TODO: Start MCP server (P0-4)
  // TODO: Start watch-driver with self-watch on src/brain/** (P0-3)
  // TODO: Wire SIGINT/SIGTERM → graceful shutdown
}
