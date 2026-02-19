import type { WatchPlan, FileEvent, FileEventEffects } from "../../shell/brain-api.ts";
import type { OpenReloadConfig, PluginState } from "../config/types.ts";

const DEFAULT_IGNORE = ["node_modules", ".git", "dist"];

export type ClassifiedEffects = FileEventEffects & {
  reloadPlugins: string[];
};

export function buildWatchPlan(config: OpenReloadConfig): WatchPlan {
  const roots = new Set<string>();

  for (const plugin of config.plugins) {
    const root = plugin.worktreePath ?? plugin.watchDir;
    if (root) {
      roots.add(root);
    }
  }

  return {
    roots: Array.from(roots),
    recursive: true,
    debounceMs: config.debounceMs ?? 300,
    ignore: DEFAULT_IGNORE,
  };
}

export function classifyEvents(
  events: FileEvent[],
  plugins: PluginState[]
): ClassifiedEffects {
  const reloadPlugins = new Set<string>();
  let reloadBrain = false;
  let refreshWatchPlan = false;

  for (const event of events) {
    for (const plugin of plugins) {
      const watchDir = plugin.config.worktreePath ?? plugin.config.watchDir;
      if (watchDir && event.path.startsWith(watchDir)) {
        reloadPlugins.add(plugin.config.name);
      }
    }

    // If the event is in the config directory, might need to refresh watch plan
    // (config change detection is a future feature, but the hook is here)
  }

  return {
    reloadPlugins: Array.from(reloadPlugins),
    reloadBrain,
    refreshWatchPlan,
  };
}
