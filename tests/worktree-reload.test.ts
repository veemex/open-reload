import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { loadPluginModule, resolveEffectiveEntry } from "../src/brain/loader/module-loader.ts";
import { buildWatchPlan, classifyEvents } from "../src/brain/watcher/policy.ts";
import type { FileEvent } from "../src/shell/brain-api.ts";
import type { PluginConfig, PluginState, OpenReloadConfig, ManagedTool } from "../src/brain/config/types.ts";

const MOCK_PLUGIN_DIR = resolve(import.meta.dir, "..", "dev", "mock-plugin");
const MOCK_WORKTREE_DIR = resolve(import.meta.dir, "..", "dev", "mock-worktree-plugin");

function makeConfig(overrides: Partial<PluginConfig> & Pick<PluginConfig, "name" | "entry" | "exportType">): PluginConfig {
  return { ...overrides };
}

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

function pluginState(config: PluginConfig): PluginState {
  return {
    config,
    tools: [mockTool("run", config.name)],
    resources: [],
    prompts: [],
    lastReloadAt: Date.now(),
    status: "loaded",
    lastError: null,
    reloadCount: 1,
  };
}

describe("resolveEffectiveEntry", () => {
  it("returns original entry when no worktreePath", () => {
    const config = makeConfig({
      name: "test",
      entry: "/repos/foo/src/index.ts",
      watchDir: "/repos/foo/src",
      exportType: "tool-array",
    });
    expect(resolveEffectiveEntry(config)).toBe("/repos/foo/src/index.ts");
  });

  it("rebases entry onto worktreePath", () => {
    const config = makeConfig({
      name: "test",
      entry: "/repos/foo/src/index.ts",
      watchDir: "/repos/foo/src",
      exportType: "tool-array",
      worktreePath: "/worktrees/env_123/foo/src",
    });
    expect(resolveEffectiveEntry(config)).toBe("/worktrees/env_123/foo/src/index.ts");
  });

  it("handles nested entry relative to watchDir", () => {
    const config = makeConfig({
      name: "test",
      entry: "/repos/foo/src/lib/entry.ts",
      watchDir: "/repos/foo/src",
      exportType: "tool-array",
      worktreePath: "/worktrees/env_123/foo/src",
    });
    expect(resolveEffectiveEntry(config)).toBe("/worktrees/env_123/foo/src/lib/entry.ts");
  });

  it("falls back to dirname(entry) when watchDir absent", () => {
    const config = makeConfig({
      name: "test",
      entry: "/repos/foo/src/index.ts",
      exportType: "tool-array",
      worktreePath: "/worktrees/env_123/foo/src",
    });
    expect(resolveEffectiveEntry(config)).toBe("/worktrees/env_123/foo/src/index.ts");
  });
});

describe("worktree-aware plugin loading", () => {
  it("loads plugin from worktree entry when worktreePath is set", async () => {
    const config = makeConfig({
      name: "wt",
      entry: resolve(MOCK_PLUGIN_DIR, "index.ts"),
      watchDir: MOCK_PLUGIN_DIR,
      exportType: "tool-array",
      worktreePath: MOCK_WORKTREE_DIR,
    });

    const { tools } = await loadPluginModule(config);
    expect(tools.length).toBe(1);
    expect(tools[0].originalName).toBe("echo");

    const result = await tools[0].execute({ message: "hello" });
    expect(result).toBe("[worktree] hello");
  });

  it("parent repo loading still works without worktreePath", async () => {
    const config = makeConfig({
      name: "parent",
      entry: resolve(MOCK_PLUGIN_DIR, "index.ts"),
      watchDir: MOCK_PLUGIN_DIR,
      exportType: "tool-array",
    });

    const { tools } = await loadPluginModule(config);
    expect(tools.length).toBe(3);
    const echo = tools.find((t) => t.originalName === "echo");
    const result = await echo!.execute({ message: "hello" });
    expect(result).toBe("hello");
  });

  it("worktreePath overrides entry for module import", async () => {
    const config = makeConfig({
      name: "override",
      entry: resolve(MOCK_PLUGIN_DIR, "index.ts"),
      watchDir: MOCK_PLUGIN_DIR,
      exportType: "tool-array",
      worktreePath: MOCK_WORKTREE_DIR,
    });

    const { tools } = await loadPluginModule(config);
    const echo = tools.find((t) => t.originalName === "echo");
    const result = await echo!.execute({ message: "test" });
    expect(result).toContain("[worktree]");
  });
});

describe("worktree-aware watch plan", () => {
  it("uses worktreePath as watch root when set", () => {
    const config: OpenReloadConfig = {
      plugins: [
        {
          name: "alpha",
          entry: "/repos/alpha/src/index.ts",
          watchDir: "/repos/alpha/src",
          exportType: "tool-array",
          worktreePath: "/worktrees/env_1/alpha/src",
        },
      ],
    };

    const plan = buildWatchPlan(config);
    expect(plan.roots).toEqual(["/worktrees/env_1/alpha/src"]);
  });

  it("falls back to watchDir when worktreePath absent", () => {
    const config: OpenReloadConfig = {
      plugins: [
        {
          name: "alpha",
          entry: "/repos/alpha/src/index.ts",
          watchDir: "/repos/alpha/src",
          exportType: "tool-array",
        },
      ],
    };

    const plan = buildWatchPlan(config);
    expect(plan.roots).toEqual(["/repos/alpha/src"]);
  });

  it("mixes worktree and non-worktree plugins", () => {
    const config: OpenReloadConfig = {
      plugins: [
        {
          name: "alpha",
          entry: "/repos/alpha/src/index.ts",
          watchDir: "/repos/alpha/src",
          exportType: "tool-array",
          worktreePath: "/worktrees/env_1/alpha/src",
        },
        {
          name: "beta",
          entry: "/repos/beta/src/index.ts",
          watchDir: "/repos/beta/src",
          exportType: "tool-array",
        },
      ],
    };

    const plan = buildWatchPlan(config);
    expect(plan.roots).toContain("/worktrees/env_1/alpha/src");
    expect(plan.roots).toContain("/repos/beta/src");
    expect(plan.roots.length).toBe(2);
  });
});

describe("worktree-aware event classification", () => {
  it("matches events from worktree path", () => {
    const config: PluginConfig = {
      name: "alpha",
      entry: "/repos/alpha/src/index.ts",
      watchDir: "/repos/alpha/src",
      exportType: "tool-array",
      worktreePath: "/worktrees/env_1/alpha/src",
    };

    const events: FileEvent[] = [
      { path: "/worktrees/env_1/alpha/src/index.ts", kind: "change" },
    ];

    const result = classifyEvents(events, [pluginState(config)]);
    expect(result.reloadPlugins).toEqual(["alpha"]);
  });

  it("does not match events from parent repo when worktreePath is set", () => {
    const config: PluginConfig = {
      name: "alpha",
      entry: "/repos/alpha/src/index.ts",
      watchDir: "/repos/alpha/src",
      exportType: "tool-array",
      worktreePath: "/worktrees/env_1/alpha/src",
    };

    const events: FileEvent[] = [
      { path: "/repos/alpha/src/index.ts", kind: "change" },
    ];

    const result = classifyEvents(events, [pluginState(config)]);
    expect(result.reloadPlugins).toEqual([]);
  });
});
