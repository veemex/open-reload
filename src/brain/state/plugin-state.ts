import type {
  ManagedResource,
  ManagedTool,
  PluginConfig,
  PluginState,
} from "../config/types.ts";
import type { BrainSnapshot } from "../../shell/brain-api.ts";

type PluginSnapshotEntry = {
  reloadCount: number;
  status: "loaded" | "error" | "loading";
  lastError: string | null;
  toolNames: string[];
  resourceUris: string[];
};

type PluginsSnapshot = {
  plugins: Record<string, PluginSnapshotEntry>;
};

export class PluginStateManager {
  private plugins: Map<string, PluginState> = new Map();

  setLoading(name: string, config: PluginConfig): void {
    const existing = this.plugins.get(name);
    this.plugins.set(name, {
      config,
      tools: existing?.tools ?? [],       // keep old tools during reload
      resources: existing?.resources ?? [],
      lastReloadAt: Date.now(),
      status: "loading",
      lastError: null,
      reloadCount: existing ? existing.reloadCount + 1 : 0,
    });
  }

  setLoaded(
    name: string,
    config: PluginConfig,
    tools: ManagedTool[],
    resources: ManagedResource[] = [],
    dispose?: () => Promise<void>
  ): void {
    const existing = this.plugins.get(name);
    this.plugins.set(name, {
      config,
      tools,
      resources,
      lastReloadAt: Date.now(),
      status: "loaded",
      lastError: null,
      reloadCount: existing?.reloadCount ?? 1,
      dispose,
    });
  }

  setError(name: string, config: PluginConfig, error: string): void {
    const existing = this.plugins.get(name);
    this.plugins.set(name, {
      config,
      tools: existing?.tools ?? [],       // keep last-known-good tools
      resources: existing?.resources ?? [],
      lastReloadAt: Date.now(),
      status: "error",
      lastError: error,
      reloadCount: existing?.reloadCount ?? 0,
    });
  }

  getState(name: string): PluginState | undefined {
    return this.plugins.get(name);
  }

  getAllStates(): PluginState[] {
    return Array.from(this.plugins.values());
  }

  getAllTools(): ManagedTool[] {
    const tools: ManagedTool[] = [];
    for (const state of this.plugins.values()) {
      if (state.status !== "loading") {
        // Include tools from "loaded" AND "error" (last-known-good)
        tools.push(...state.tools);
      }
    }
    return tools;
  }

  getAllResources(): ManagedResource[] {
    const resources: ManagedResource[] = [];
    for (const state of this.plugins.values()) {
      if (state.status !== "loading") {
        resources.push(...state.resources);
      }
    }
    return resources;
  }

  toSnapshot(): BrainSnapshot {
    const entries: Record<string, PluginSnapshotEntry> = {};
    for (const [name, state] of this.plugins) {
      entries[name] = {
        reloadCount: state.reloadCount,
        status: state.status,
        lastError: state.lastError,
        toolNames: state.tools.map((t) => t.originalName),
        resourceUris: state.resources.map((r) => r.uri),
      };
    }
    return { plugins: entries } as BrainSnapshot;
  }

  restoreFromSnapshot(snap: BrainSnapshot): void {
    const data = snap as Partial<PluginsSnapshot>;
    if (!data.plugins || typeof data.plugins !== "object") return;
    
    for (const [name, entry] of Object.entries(data.plugins)) {
      const existing = this.plugins.get(name);
      if (existing) {
        // Restore metadata from snapshot, keep tools from fresh load
        existing.reloadCount = entry.reloadCount;
        // Don't restore status/lastError — let fresh load determine those
      }
      // If plugin not yet loaded, store the reload count for later
      // (it'll be picked up when setLoading/setLoaded is called)
    }
  }
}
