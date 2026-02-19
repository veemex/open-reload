import { resolve, join } from "path";
import { readdirSync, statSync } from "fs";
import type { BrainAPI, BrainContext, BrainFactory, BrainInit } from "./brain-api.ts";

const BRAIN_DIR = resolve(import.meta.dir, "..", "brain");
const BRAIN_ENTRY = join(BRAIN_DIR, "entry.ts");

function collectModulePaths(dir: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      paths.push(...collectModulePaths(full));
    } else if (/\.(ts|js|mts|mjs)$/.test(entry)) {
      paths.push(full);
    }
  }
  return paths;
}

function purgeBrainModules(): void {
  const loader = (globalThis as Record<string, unknown>).Loader as
    | Record<string, unknown>
    | undefined;
  const registry = loader?.registry as
    | { delete?: (path: string) => void }
    | undefined;

  if (!registry?.delete) return;

  for (const modulePath of collectModulePaths(BRAIN_DIR)) {
    registry.delete(modulePath);
  }
}

export async function loadBrain(
  ctx: BrainContext,
  init: BrainInit
): Promise<BrainAPI> {
  purgeBrainModules();
  const mod = await import(`${BRAIN_ENTRY}?t=${Date.now()}`);
  const factory = (mod.default ?? mod.factory) as BrainFactory;
  return factory.create(ctx, init);
}

export async function swapBrain(
  ctx: BrainContext,
  activeBrain: BrainAPI | null,
  configPath?: string,
): Promise<BrainAPI> {
  const snapshot = activeBrain ? await activeBrain.exportSnapshot() : undefined;

  try {
    const newBrain = await loadBrain(ctx, { snapshot, configPath });

    if (activeBrain) {
      await activeBrain.dispose();
    }

    return newBrain;
  } catch (err) {
    ctx.logErr(`Brain reload failed: ${err instanceof Error ? err.message : String(err)}`);
    if (activeBrain) return activeBrain;
    throw err;
  }
}
