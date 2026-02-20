import { describe, it, expect, beforeEach } from "bun:test";
import {
  TrampolineRegistry,
  type ToolExecuteFn,
  type HookFn,
} from "../src/native/trampolines.ts";

describe("TrampolineRegistry", () => {
  let registry: TrampolineRegistry;

  beforeEach(() => {
    registry = new TrampolineRegistry();
  });

  describe("tool backings", () => {
    it("stores and retrieves a tool backing", () => {
      const execute: ToolExecuteFn = async () => "result";
      registry.setToolBacking("plugin_tool", execute);
      expect(registry.hasToolBacking("plugin_tool")).toBe(true);
    });

    it("reports missing backing", () => {
      expect(registry.hasToolBacking("nonexistent")).toBe(false);
    });

    it("removes a tool backing", () => {
      registry.setToolBacking("plugin_tool", async () => "result");
      registry.removeToolBacking("plugin_tool");
      expect(registry.hasToolBacking("plugin_tool")).toBe(false);
    });

    it("overwrites backing on re-set", async () => {
      registry.setToolBacking("plugin_tool", async () => "v1");
      registry.setToolBacking("plugin_tool", async () => "v2");
      const trampoline = registry.createToolTrampoline("plugin_tool");
      expect(await trampoline({}, undefined)).toBe("v2");
    });
  });

  describe("tool trampolines", () => {
    it("delegates to the current backing", async () => {
      registry.setToolBacking("plugin_tool", async (args) => {
        return `hello ${(args as Record<string, string>).name}`;
      });
      const trampoline = registry.createToolTrampoline("plugin_tool");
      const result = await trampoline({ name: "world" }, undefined);
      expect(result).toBe("hello world");
    });

    it("forwards context to backing", async () => {
      let receivedCtx: unknown;
      registry.setToolBacking("plugin_tool", async (_args, ctx) => {
        receivedCtx = ctx;
        return "ok";
      });
      const trampoline = registry.createToolTrampoline("plugin_tool");
      const ctx = { sessionID: "s1", agent: "build" };
      await trampoline({}, ctx);
      expect(receivedCtx).toEqual(ctx);
    });

    it("throws when backing is missing", async () => {
      const trampoline = registry.createToolTrampoline("missing_tool");
      expect(trampoline({}, undefined)).rejects.toThrow("not loaded");
    });

    it("reflects backing swap without re-creating trampoline", async () => {
      registry.setToolBacking("plugin_tool", async () => "v1");
      const trampoline = registry.createToolTrampoline("plugin_tool");
      expect(await trampoline({}, undefined)).toBe("v1");

      registry.setToolBacking("plugin_tool", async () => "v2");
      expect(await trampoline({}, undefined)).toBe("v2");
    });

    it("throws after backing is removed", async () => {
      registry.setToolBacking("plugin_tool", async () => "v1");
      const trampoline = registry.createToolTrampoline("plugin_tool");
      expect(await trampoline({}, undefined)).toBe("v1");

      registry.removeToolBacking("plugin_tool");
      expect(trampoline({}, undefined)).rejects.toThrow("not loaded");
    });

    it("prefers route backing over default backing when context matches", async () => {
      registry.setToolBacking("plugin_tool", async () => "default");
      registry.registerRoute(
        "plugin_tool",
        "env_abc123",
        async () => "route",
        { routeKey: "ignored", worktreePrefix: "/tmp/worktrees/env_abc123/repo" },
      );

      const trampoline = registry.createToolTrampoline("plugin_tool");
      expect(
        await trampoline({}, { worktree: "/tmp/worktrees/env_abc123/repo/src" }),
      ).toBe("route");
    });

    it("falls back to default backing when no route matches", async () => {
      registry.setToolBacking("plugin_tool", async () => "default");
      registry.registerRoute(
        "plugin_tool",
        "env_abc123",
        async () => "route",
        { routeKey: "env_abc123", worktreePrefix: "/tmp/worktrees/env_abc123/repo" },
      );

      const trampoline = registry.createToolTrampoline("plugin_tool");
      expect(
        await trampoline({}, { worktree: "/tmp/worktrees/env_other/repo" }),
      ).toBe("default");
    });
  });

  describe("route backings", () => {
    it("resolves a matching route by worktree prefix", async () => {
      registry.registerRoute(
        "plugin_tool",
        "env_abc123",
        async () => "route",
        { routeKey: "env_abc123", worktreePrefix: "/tmp/worktrees/env_abc123/repo" },
      );

      const execute = registry.resolveRoute("plugin_tool", {
        worktree: "/tmp/worktrees/env_abc123/repo/src",
      });
      expect(execute).toBeDefined();
      expect(await execute!({}, {})).toBe("route");
    });

    it("uses longest worktree prefix when multiple routes match", async () => {
      registry.registerRoute(
        "plugin_tool",
        "generic",
        async () => "generic",
        { routeKey: "generic", worktreePrefix: "/tmp/worktrees" },
      );
      registry.registerRoute(
        "plugin_tool",
        "specific",
        async () => "specific",
        { routeKey: "specific", worktreePrefix: "/tmp/worktrees/env_abc123/repo" },
      );

      const execute = registry.resolveRoute("plugin_tool", {
        worktree: "/tmp/worktrees/env_abc123/repo/subdir",
      });
      expect(execute).toBeDefined();
      expect(await execute!({}, {})).toBe("specific");
    });

    it("unregisters a specific route", () => {
      registry.registerRoute(
        "plugin_tool",
        "env_abc123",
        async () => "route",
        { routeKey: "env_abc123", worktreePrefix: "/tmp/worktrees/env_abc123/repo" },
      );
      registry.unregisterRoute("plugin_tool", "env_abc123");

      expect(
        registry.resolveRoute("plugin_tool", {
          worktree: "/tmp/worktrees/env_abc123/repo/src",
        }),
      ).toBeUndefined();
    });

    it("returns route keys for a tool", () => {
      registry.registerRoute("plugin_tool", "env_a", async () => "a", {
        routeKey: "env_a",
        worktreePrefix: "/tmp/worktrees/env_a/repo",
      });
      registry.registerRoute("plugin_tool", "env_b", async () => "b", {
        routeKey: "env_b",
        worktreePrefix: "/tmp/worktrees/env_b/repo",
      });

      expect(registry.getRouteKeys("plugin_tool")).toEqual(["env_a", "env_b"]);
    });

    it("clearRoutes removes routes but preserves default backings", async () => {
      registry.setToolBacking("plugin_tool", async () => "default");
      registry.registerRoute(
        "plugin_tool",
        "env_abc123",
        async () => "route",
        { routeKey: "env_abc123", worktreePrefix: "/tmp/worktrees/env_abc123/repo" },
      );

      registry.clearRoutes();

      expect(registry.getRouteKeys("plugin_tool")).toEqual([]);
      const trampoline = registry.createToolTrampoline("plugin_tool");
      expect(
        await trampoline({}, { worktree: "/tmp/worktrees/env_abc123/repo/src" }),
      ).toBe("default");
    });
  });

  describe("hook entries", () => {
    it("adds and retrieves hook entries by type", () => {
      const fn: HookFn = async () => {};
      registry.addHookEntry("event", "pluginA", fn);
      const entries = registry.getHookEntries("event");
      expect(entries).toHaveLength(1);
      expect(entries[0].pluginName).toBe("pluginA");
    });

    it("aggregates entries from multiple plugins", () => {
      registry.addHookEntry("event", "pluginA", async () => {});
      registry.addHookEntry("event", "pluginB", async () => {});
      expect(registry.getHookEntries("event")).toHaveLength(2);
    });

    it("returns empty array for unknown hook type", () => {
      expect(registry.getHookEntries("nonexistent")).toHaveLength(0);
    });

    it("removes all hooks for a specific plugin", () => {
      registry.addHookEntry("event", "pluginA", async () => {});
      registry.addHookEntry("chat.params", "pluginA", async () => {});
      registry.addHookEntry("event", "pluginB", async () => {});

      registry.removePluginHooks("pluginA");

      expect(registry.getHookEntries("event")).toHaveLength(1);
      expect(registry.getHookEntries("event")[0].pluginName).toBe("pluginB");
      expect(registry.getHookEntries("chat.params")).toHaveLength(0);
    });

    it("handles removing hooks for non-existent plugin", () => {
      registry.addHookEntry("event", "pluginA", async () => {});
      registry.removePluginHooks("nonexistent");
      expect(registry.getHookEntries("event")).toHaveLength(1);
    });
  });

  describe("hook trampolines", () => {
    it("calls all backings in order", async () => {
      const order: string[] = [];
      registry.addHookEntry("event", "pluginA", async () => {
        order.push("A");
      });
      registry.addHookEntry("event", "pluginB", async () => {
        order.push("B");
      });

      const trampoline = registry.createHookTrampoline("event");
      await trampoline({ event: "test" });
      expect(order).toEqual(["A", "B"]);
    });

    it("is a no-op when no backings exist", async () => {
      const trampoline = registry.createHookTrampoline("event");
      await trampoline({ event: "test" });
    });

    it("forwards all arguments to backings", async () => {
      let receivedArgs: unknown[];
      registry.addHookEntry("chat.params", "pluginA", async (...args) => {
        receivedArgs = args;
      });

      const trampoline = registry.createHookTrampoline("chat.params");
      const input = { sessionID: "s1" };
      const output = { temperature: 0.7 };
      await trampoline(input, output);
      expect(receivedArgs![0]).toEqual(input);
      expect(receivedArgs![1]).toEqual(output);
    });

    it("allows output mutation across backings", async () => {
      registry.addHookEntry("chat.params", "pluginA", async (_input, output) => {
        (output as Record<string, number>).temperature = 0.5;
      });
      registry.addHookEntry("chat.params", "pluginB", async (_input, output) => {
        (output as Record<string, number>).topP = 0.9;
      });

      const trampoline = registry.createHookTrampoline("chat.params");
      const output = { temperature: 0.7, topP: 1.0 };
      await trampoline({}, output);
      expect(output.temperature).toBe(0.5);
      expect(output.topP).toBe(0.9);
    });

    it("continues after backing error", async () => {
      const calls: string[] = [];
      registry.addHookEntry("event", "pluginA", async () => {
        throw new Error("boom");
      });
      registry.addHookEntry("event", "pluginB", async () => {
        calls.push("B");
      });

      const trampoline = registry.createHookTrampoline("event");
      await trampoline({ event: "test" });
      expect(calls).toEqual(["B"]);
    });

    it("reflects backing changes without re-creating trampoline", async () => {
      registry.addHookEntry("event", "pluginA", async () => {});
      const trampoline = registry.createHookTrampoline("event");

      registry.removePluginHooks("pluginA");
      registry.addHookEntry("event", "pluginA", async () => {});
      registry.addHookEntry("event", "pluginC", async () => {});

      let callCount = 0;
      const entries = registry.getHookEntries("event");
      expect(entries).toHaveLength(2);

      await trampoline({});
    });
  });

  describe("clear", () => {
    it("removes all tool backings and hook entries", () => {
      registry.setToolBacking("t1", async () => "x");
      registry.setToolBacking("t2", async () => "y");
      registry.registerRoute("t1", "env_1", async () => "route", {
        routeKey: "env_1",
        worktreePrefix: "/tmp/worktrees/env_1/repo",
      });
      registry.addHookEntry("event", "p1", async () => {});

      registry.clear();

      expect(registry.hasToolBacking("t1")).toBe(false);
      expect(registry.hasToolBacking("t2")).toBe(false);
      expect(registry.getRouteKeys("t1")).toHaveLength(0);
      expect(registry.getHookEntries("event")).toHaveLength(0);
    });
  });
});
