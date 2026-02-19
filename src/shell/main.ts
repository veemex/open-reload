import type { BrainAPI, BrainContext, FileEvent } from "./brain-api.ts";
import { swapBrain } from "./brain-loader.ts";
import type { ShellStatus } from "./core-tools.ts";
import { startMcpServer, type McpHandle } from "./mcp.ts";
import { FileWatcher } from "./watch-driver.ts";
import { resolve, relative } from "path";

function parseConfigArg(): string | undefined {
  const idx = process.argv.indexOf("--config");
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return resolve(process.argv[idx + 1]);
}

export async function main(): Promise<void> {
  const ctx: BrainContext = {
    cwd: process.cwd(),
    nowMs: () => Date.now(),
    logErr: (line) => process.stderr.write(line + "\n"),
  };

  const configPath = parseConfigArg();

  let activeBrain: BrainAPI | null = null;
  let reloadCount = 0;
  let lastReloadAt: number | null = null;
  let lastError: string | null = null;
  let toolCount = 0;
  let mcp: McpHandle;
  const pluginWatchers = new Map<string, FileWatcher>();

  const onPluginFileChange = async (changedPath: string) => {
    if (!activeBrain) return;
    const event: FileEvent = { path: changedPath, kind: "change" };
    const effects = await activeBrain.onFileEvents([event]);
    if (effects.reloadBrain) {
      void reload();
    } else {
      toolCount = (await activeBrain.listTools()).length;
      await mcp.syncBrainTools();
      ctx.logErr(`Plugin file changed: ${relative(ctx.cwd, changedPath)}`);
    }
  };

  const syncPluginWatchers = async () => {
    if (!activeBrain) return;
    const plan = await activeBrain.getWatchPlan();
    const newRoots = new Set(plan.roots);

    for (const [root, watcher] of pluginWatchers) {
      if (!newRoots.has(root)) {
        watcher.stop();
        pluginWatchers.delete(root);
        ctx.logErr(`Stopped watching plugin dir: ${root}`);
      }
    }

    for (const root of newRoots) {
      if (!pluginWatchers.has(root)) {
        const watcher = new FileWatcher({
          watchDir: root,
          debounceMs: plan.debounceMs,
          onChange: (changedPath) => {
            void onPluginFileChange(changedPath);
          },
          ignorePatterns: plan.ignore,
        });
        watcher.start();
        pluginWatchers.set(root, watcher);
        ctx.logErr(`Watching plugin dir: ${root}`);
      }
    }
  };

  const reload = async () => {
    try {
      activeBrain = await swapBrain(ctx, activeBrain, configPath);
      toolCount = (await activeBrain.listTools()).length;
      reloadCount++;
      lastReloadAt = Date.now();
      lastError = null;
      await mcp.syncBrainTools();
      await syncPluginWatchers();
      ctx.logErr(`Brain reloaded (#${reloadCount})`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      ctx.logErr(`Brain reload failed: ${lastError}`);
    }
  };

  const getStatus = (): ShellStatus => ({
    brainLoaded: activeBrain !== null,
    lastReloadAt,
    lastError,
    reloadCount,
    pluginCount: toolCount,
  });

  mcp = await startMcpServer({
    getActiveBrain: () => activeBrain,
    onReloadRequest: reload,
    getStatus,
    getCwd: () => process.cwd(),
  });

  await reload();

  const BRAIN_DIR = resolve(import.meta.dir, "..", "brain");
  const selfWatcher = new FileWatcher({
    watchDir: BRAIN_DIR,
    debounceMs: 300,
    onChange: () => {
      void reload();
    },
  });
  selfWatcher.start();

  const shutdown = async () => {
    selfWatcher.stop();
    for (const [, watcher] of pluginWatchers) {
      watcher.stop();
    }
    pluginWatchers.clear();
    if (activeBrain) {
      await activeBrain.dispose();
    }
    await mcp.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
