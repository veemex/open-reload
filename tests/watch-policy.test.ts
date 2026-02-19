import { describe, it, expect } from "bun:test";
import { buildWatchPlan, classifyEvents } from "../src/brain/watcher/policy.ts";
import type { FileEvent } from "../src/shell/brain-api.ts";
import type { OpenReloadConfig, PluginConfig, PluginState, ManagedTool } from "../src/brain/config/types.ts";

function mockTool(name: string, pluginName: string): ManagedTool {
  return {
    qualifiedName: `${pluginName}_${name}`,
    originalName: name,
    pluginName,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: async (input) => JSON.stringify(input),
  };
}

function pluginConfig(name: string, watchDir?: string): PluginConfig {
  return {
    name,
    entry: `/tmp/${name}.ts`,
    watchDir,
    exportType: "tool-array",
  };
}

function pluginState(name: string, watchDir: string): PluginState {
  return {
    config: pluginConfig(name, watchDir),
    tools: [mockTool("run", name)],
    resources: [],
    lastReloadAt: Date.now(),
    status: "loaded",
    lastError: null,
    reloadCount: 1,
  };
}

describe("buildWatchPlan", () => {
  it("collects unique watchDirs as roots", () => {
    const config: OpenReloadConfig = {
      plugins: [
        pluginConfig("alpha", "/plugins/alpha"),
        pluginConfig("beta", "/plugins/beta"),
      ],
    };

    expect(buildWatchPlan(config).roots).toEqual(["/plugins/alpha", "/plugins/beta"]);
  });

  it("deduplicates roots", () => {
    const config: OpenReloadConfig = {
      plugins: [
        pluginConfig("alpha", "/plugins/shared"),
        pluginConfig("beta", "/plugins/shared"),
      ],
    };

    expect(buildWatchPlan(config).roots).toEqual(["/plugins/shared"]);
  });

  it("uses config debounceMs", () => {
    const config: OpenReloadConfig = {
      plugins: [pluginConfig("alpha", "/plugins/alpha")],
      debounceMs: 150,
    };

    expect(buildWatchPlan(config).debounceMs).toBe(150);
  });

  it("defaults debounceMs to 300", () => {
    const config: OpenReloadConfig = {
      plugins: [pluginConfig("alpha", "/plugins/alpha")],
    };

    expect(buildWatchPlan(config).debounceMs).toBe(300);
  });

  it("returns empty roots for no plugins", () => {
    const config: OpenReloadConfig = {
      plugins: [],
    };

    expect(buildWatchPlan(config).roots).toEqual([]);
  });
});

describe("classifyEvents", () => {
  it("identifies plugin to reload from matching path", () => {
    const events: FileEvent[] = [{ path: "/plugins/alpha/index.ts", kind: "change" }];
    const plugins: PluginState[] = [pluginState("alpha", "/plugins/alpha")];

    expect(classifyEvents(events, plugins).reloadPlugins).toEqual(["alpha"]);
  });

  it("deduplicates plugin names", () => {
    const events: FileEvent[] = [
      { path: "/plugins/alpha/a.ts", kind: "change" },
      { path: "/plugins/alpha/b.ts", kind: "create" },
    ];
    const plugins: PluginState[] = [pluginState("alpha", "/plugins/alpha")];

    expect(classifyEvents(events, plugins).reloadPlugins).toEqual(["alpha"]);
  });

  it("returns empty reloadPlugins for no match", () => {
    const events: FileEvent[] = [{ path: "/unrelated/path.ts", kind: "change" }];
    const plugins: PluginState[] = [pluginState("alpha", "/plugins/alpha")];

    expect(classifyEvents(events, plugins).reloadPlugins).toEqual([]);
  });

  it("handles multiple events across different plugins", () => {
    const events: FileEvent[] = [
      { path: "/plugins/alpha/a.ts", kind: "change" },
      { path: "/plugins/beta/b.ts", kind: "delete" },
      { path: "/plugins/alpha/c.ts", kind: "rename" },
    ];
    const plugins: PluginState[] = [
      pluginState("alpha", "/plugins/alpha"),
      pluginState("beta", "/plugins/beta"),
    ];

    expect(classifyEvents(events, plugins).reloadPlugins).toEqual(["alpha", "beta"]);
  });
});
