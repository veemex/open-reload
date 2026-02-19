import { describe, it, expect } from "bun:test";
import { PluginStateManager } from "../src/brain/state/plugin-state.ts";
import type { ManagedTool, PluginConfig } from "../src/brain/config/types.ts";
import type { BrainSnapshot } from "../src/shell/brain-api.ts";

const mockConfig: PluginConfig = {
  name: "test",
  entry: "/tmp/test.ts",
  exportType: "tool-array",
};

function mockTool(name: string, pluginName = "test"): ManagedTool {
  return {
    qualifiedName: `${pluginName}_${name}`,
    originalName: name,
    pluginName,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: async (input) => JSON.stringify(input),
  };
}

describe("PluginStateManager", () => {
  describe("lifecycle", () => {
    it("setLoading creates initial state", () => {
      const manager = new PluginStateManager();
      manager.setLoading("test", mockConfig);

      const state = manager.getState("test");
      expect(state).toBeDefined();
      expect(state?.status).toBe("loading");
      expect(state?.tools).toEqual([]);
      expect(state?.lastError).toBeNull();
      expect(state?.reloadCount).toBe(0);
    });

    it("setLoaded updates tools and status", () => {
      const manager = new PluginStateManager();
      const tools = [mockTool("alpha")];

      manager.setLoading("test", mockConfig);
      manager.setLoaded("test", mockConfig, tools);

      const state = manager.getState("test");
      expect(state?.status).toBe("loaded");
      expect(state?.tools).toEqual(tools);
      expect(state?.lastError).toBeNull();
    });

    it("setError preserves last-known-good tools", () => {
      const manager = new PluginStateManager();
      const tools = [mockTool("stable")];

      manager.setLoaded("test", mockConfig, tools);
      manager.setError("test", mockConfig, "failed to import");

      const state = manager.getState("test");
      expect(state?.status).toBe("error");
      expect(state?.lastError).toBe("failed to import");
      expect(state?.tools).toEqual(tools);
    });

    it("setLoading increments reloadCount", () => {
      const manager = new PluginStateManager();

      manager.setLoaded("test", mockConfig, [mockTool("one")]);
      expect(manager.getState("test")?.reloadCount).toBe(1);

      manager.setLoading("test", mockConfig);
      expect(manager.getState("test")?.reloadCount).toBe(2);
    });
  });

  describe("getAllTools", () => {
    it("returns tools from loaded plugins", () => {
      const manager = new PluginStateManager();
      const tools = [mockTool("loaded")];

      manager.setLoaded("test", mockConfig, tools);

      expect(manager.getAllTools()).toEqual(tools);
    });

    it("returns tools from error plugins (last-known-good)", () => {
      const manager = new PluginStateManager();
      const tools = [mockTool("safe")];

      manager.setLoaded("test", mockConfig, tools);
      manager.setError("test", mockConfig, "oops");

      expect(manager.getAllTools()).toEqual(tools);
    });

    it("excludes tools from loading plugins", () => {
      const manager = new PluginStateManager();
      const name = "test";

      manager.setLoaded(name, mockConfig, [mockTool("old")]);
      manager.setLoading(name, mockConfig);

      expect(manager.getAllTools()).toEqual([]);
    });

    it("returns empty for no plugins", () => {
      const manager = new PluginStateManager();
      expect(manager.getAllTools()).toEqual([]);
    });
  });

  describe("snapshot", () => {
    it("toSnapshot returns JSON-serializable object", () => {
      const manager = new PluginStateManager();
      manager.setLoaded("test", mockConfig, [mockTool("alpha")]);

      const snap = manager.toSnapshot();
      expect(() => JSON.stringify(snap)).not.toThrow();
    });

    it("toSnapshot includes reloadCount and toolNames", () => {
      const manager = new PluginStateManager();
      manager.setLoaded("test", mockConfig, [mockTool("alpha"), mockTool("beta")]);

      const snap = manager.toSnapshot();
      expect(snap).toEqual({
        plugins: {
          test: {
            reloadCount: 1,
            status: "loaded",
            lastError: null,
            toolNames: ["alpha", "beta"],
            resourceUris: [],
            promptNames: [],
          },
        },
      });
    });

    it("toSnapshot does NOT include execute functions", () => {
      const manager = new PluginStateManager();
      manager.setLoaded("test", mockConfig, [mockTool("alpha")]);

      const json = JSON.stringify(manager.toSnapshot());
      expect(json.includes("execute")).toBe(false);
    });

    it("restoreFromSnapshot preserves reloadCount", () => {
      const manager = new PluginStateManager();
      manager.setLoaded("test", mockConfig, [mockTool("alpha")]);

      const incoming: BrainSnapshot = {
        plugins: {
          test: {
            reloadCount: 7,
            status: "error",
            lastError: "old",
            toolNames: ["alpha"],
          },
        },
      };

      manager.restoreFromSnapshot(incoming);
      expect(manager.getState("test")?.reloadCount).toBe(7);
    });

    it("restoreFromSnapshot handles empty/missing data gracefully", () => {
      const manager = new PluginStateManager();
      manager.setLoaded("test", mockConfig, [mockTool("alpha")]);

      const before = manager.getState("test")?.reloadCount;
      manager.restoreFromSnapshot({});
      manager.restoreFromSnapshot({ plugins: "invalid" });

      expect(manager.getState("test")?.reloadCount).toBe(before);
    });
  });
});
