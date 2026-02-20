import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { FileWatcher } from "../src/shell/watch-driver.ts";
import { TrampolineRegistry, type RouteSpec } from "../src/native/trampolines.ts";
import { NativePluginManager } from "../src/native/manager.ts";
import { PluginEventBus } from "../src/brain/events/event-bus.ts";
import type { OpenReloadConfig } from "../src/brain/config/types.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

function makeTmpWithNodeModules(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "native-mgr-")));
  symlinkSync(join(PROJECT_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function writePlugin(dir: string, content: string): string {
  const file = join(dir, "index.ts");
  writeFileSync(file, content);
  return file;
}

const BASIC_PLUGIN = `
import { z } from "zod";
export default async () => ({
  tool: {
    echo: {
      description: "Echoes input",
      args: { text: z.string() },
      execute: async (args) => args.text,
    },
  },
});
`;

const PLUGIN_WITH_HOOKS = `
import { z } from "zod";
export default async () => ({
  tool: {
    greet: {
      description: "Greets",
      args: { name: z.string() },
      execute: async (args) => "Hello " + args.name,
    },
  },
  event: async (input) => {},
  "tool.execute.before": async (input, output) => {},
});
`;

const UPDATED_PLUGIN = `
import { z } from "zod";
export default async () => ({
  tool: {
    echo: {
      description: "Echoes input v2",
      args: { text: z.string() },
      execute: async (args) => "v2:" + args.text,
    },
  },
});
`;

describe("NativePluginManager", () => {
  let tmpDir: string;
  let registry: TrampolineRegistry;
  let eventBus: PluginEventBus;

  beforeEach(() => {
    tmpDir = makeTmpWithNodeModules();
    registry = new TrampolineRegistry();
    eventBus = new PluginEventBus();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(
    plugins: Array<{ name: string; entry: string; watchDir: string; dependsOn?: string[] }>,
  ): OpenReloadConfig {
    return {
      plugins: plugins.map((p) => ({
        ...p,
        exportType: "opencode-plugin" as const,
        prefix: true,
      })),
      debounceMs: 50,
      logLevel: "info",
    };
  }

  describe("loadAll", () => {
    it("loads a basic plugin and registers tool backings", async () => {
      const entry = writePlugin(tmpDir, BASIC_PLUGIN);
      const config = makeConfig([
        { name: "test", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});

      const results = await manager.loadAll();

      expect(results.size).toBe(1);
      const result = results.get("test")!;
      expect(Object.keys(result.tools)).toEqual(["test_echo"]);
      expect(registry.hasToolBacking("test_echo")).toBe(true);
    });

    it("extracts hooks from plugin return", async () => {
      const entry = writePlugin(tmpDir, PLUGIN_WITH_HOOKS);
      const config = makeConfig([
        { name: "hooks", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});

      const results = await manager.loadAll();
      const result = results.get("hooks")!;

      expect(Object.keys(result.hooks)).toContain("event");
      expect(Object.keys(result.hooks)).toContain("tool.execute.before");
      expect(registry.getHookEntries("event")).toHaveLength(1);
    });

    it("skips non-opencode-plugin format plugins", async () => {
      const config: OpenReloadConfig = {
        plugins: [
          {
            name: "skip-me",
            entry: join(tmpDir, "fake.ts"),
            watchDir: tmpDir,
            exportType: "tool-array",
          },
        ],
        debounceMs: 50,
      };
      const manager = new NativePluginManager(config, registry, eventBus, {});
      const results = await manager.loadAll();
      expect(results.size).toBe(0);
    });

    it("handles load errors gracefully", async () => {
      const entry = writePlugin(tmpDir, `export default "not a function";`);
      const config = makeConfig([
        { name: "broken", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});

      const results = await manager.loadAll();
      expect(results.size).toBe(0);

      const state = manager.getState("broken");
      expect(state?.status).toBe("error");
      expect(state?.lastError).toContain("expected default export");
    });

    it("passes pluginInput to loaded plugins", async () => {
      let receivedInput: unknown;
      const pluginCode = `
        export default async (input) => {
          globalThis.__testInput = input;
          return { tool: {} };
        };
      `;
      const entry = writePlugin(tmpDir, pluginCode);
      const config = makeConfig([
        { name: "ctx", entry, watchDir: tmpDir },
      ]);
      const fakeInput = { directory: "/test", worktree: "/test", client: "mock" };
      const manager = new NativePluginManager(config, registry, eventBus, fakeInput);

      await manager.loadAll();
      const received = (globalThis as Record<string, unknown>).__testInput;
      expect(received).toEqual(fakeInput);
      delete (globalThis as Record<string, unknown>).__testInput;
    });

    it("injects events into tool execute context in native mode", async () => {
      const pluginCode = `
        export default async () => ({
          tool: {
            send: {
              description: "Send event",
              args: {},
              execute: async (_args, context) => {
                if (!context?.events) {
                  throw new Error("events missing");
                }
                await context.events.emit("test.event", { data: "hello" });
                return "ok";
              },
            },
          },
        });
      `;
      const entry = writePlugin(tmpDir, pluginCode);
      const config = makeConfig([
        { name: "events", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});

      let receivedEvent: unknown;
      const unsubscribe = eventBus.on("test.event", (event) => {
        receivedEvent = event;
      });

      try {
        const results = await manager.loadAll();
        const result = results.get("events")!;
        await result.tools.events_send.execute({}, {});

        expect(receivedEvent).toEqual({
          source: "events",
          type: "test.event",
          payload: { data: "hello" },
          timestamp: expect.any(Number),
        });
      } finally {
        unsubscribe();
      }
    });
  });

  describe("reloadPlugin", () => {
    it("re-registers tool backings on reload", async () => {
      const entry = writePlugin(tmpDir, BASIC_PLUGIN);
      const config = makeConfig([
        { name: "test", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});
      await manager.loadAll();

      expect(registry.hasToolBacking("test_echo")).toBe(true);

      await manager.reloadPlugin("test");

      expect(registry.hasToolBacking("test_echo")).toBe(true);
      expect(manager.getState("test")?.status).toBe("loaded");
      expect(manager.getState("test")?.reloadCount).toBe(1);
    });

    it("increments reload count", async () => {
      const entry = writePlugin(tmpDir, BASIC_PLUGIN);
      const config = makeConfig([
        { name: "test", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});
      await manager.loadAll();

      expect(manager.getState("test")?.reloadCount).toBe(0);

      await manager.reloadPlugin("test");
      expect(manager.getState("test")?.reloadCount).toBe(1);

      await manager.reloadPlugin("test");
      expect(manager.getState("test")?.reloadCount).toBe(2);
    });

    it("calls dispose before reload", async () => {
      let disposed = false;
      const pluginCode = `
        export default async () => ({
          tool: {},
          dispose: async () => { globalThis.__testDisposed = true; },
        });
      `;
      const entry = writePlugin(tmpDir, pluginCode);
      const config = makeConfig([
        { name: "disposable", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});
      await manager.loadAll();

      await manager.reloadPlugin("disposable");
      expect((globalThis as Record<string, unknown>).__testDisposed).toBe(true);
      delete (globalThis as Record<string, unknown>).__testDisposed;
    });

    it("updates hook backings on reload", async () => {
      const entry = writePlugin(tmpDir, PLUGIN_WITH_HOOKS);
      const config = makeConfig([
        { name: "hooked", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});
      await manager.loadAll();

      expect(registry.getHookEntries("event")).toHaveLength(1);

      await manager.reloadPlugin("hooked");

      expect(registry.getHookEntries("event")).toHaveLength(1);
      expect(registry.getHookEntries("event")[0].pluginName).toBe("hooked");
    });

    it("handles reload errors without crashing", async () => {
      const pluginCode = `
        export default async () => { throw new Error("deliberate fail"); };
      `;
      const entry = writePlugin(tmpDir, pluginCode);
      const config = makeConfig([
        { name: "broken", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});
      await manager.loadAll();

      expect(manager.getState("broken")?.status).toBe("error");
      expect(manager.getState("broken")?.lastError).toContain("deliberate fail");
    });
  });

  describe("addPlugin", () => {
    it("loads a plugin and registers tool backings", async () => {
      const entry = writePlugin(tmpDir, BASIC_PLUGIN);
      const manager = new NativePluginManager(makeConfig([]), registry, eventBus, {});

      const result = await manager.addPlugin({
        name: "dynamic",
        entry,
        watchDir: tmpDir,
        exportType: "opencode-plugin",
        prefix: true,
      });

      expect(Object.keys(result.tools)).toEqual(["dynamic_echo"]);
      expect(registry.hasToolBacking("dynamic_echo")).toBe(true);
      expect(manager.getState("dynamic")?.status).toBe("loaded");

      await manager.removePlugin("dynamic");
    });

    it("registers routes when routeSpec is provided", async () => {
      const entry = writePlugin(tmpDir, BASIC_PLUGIN);
      const manager = new NativePluginManager(makeConfig([]), registry, eventBus, {});
      const routeSpec: RouteSpec = {
        routeKey: "env_123",
        worktreePrefix: "/tmp/worktrees/env_123/repo",
      };

      await manager.addPlugin(
        {
          name: "dynamic-route",
          entry,
          exportType: "opencode-plugin",
          prefix: true,
        },
        routeSpec,
      );

      expect(registry.hasToolBacking("dynamic-route_echo")).toBe(false);
      expect(registry.getRouteKeys("dynamic-route_echo")).toEqual(["env_123"]);

      await manager.removePlugin("dynamic-route");
    });

    it("starts a per-plugin watcher when watchDir is provided", async () => {
      const originalStart = FileWatcher.prototype.start;
      let startCalls = 0;
      FileWatcher.prototype.start = function startPatched(this: FileWatcher): void {
        startCalls++;
        return originalStart.call(this);
      };

      const entry = writePlugin(tmpDir, BASIC_PLUGIN);
      const manager = new NativePluginManager(makeConfig([]), registry, eventBus, {});

      try {
        await manager.addPlugin({
          name: "watched",
          entry,
          watchDir: tmpDir,
          exportType: "opencode-plugin",
          prefix: true,
        });

        expect(startCalls).toBe(1);
      } finally {
        FileWatcher.prototype.start = originalStart;
        await manager.removePlugin("watched");
      }
    });
  });

  describe("removePlugin", () => {
    it("cleans up tool backings, hooks, and state", async () => {
      const entry = writePlugin(tmpDir, PLUGIN_WITH_HOOKS);
      const manager = new NativePluginManager(makeConfig([]), registry, eventBus, {});

      await manager.addPlugin({
        name: "cleanup",
        entry,
        exportType: "opencode-plugin",
        prefix: true,
      });
      expect(registry.hasToolBacking("cleanup_greet")).toBe(true);
      expect(registry.getHookEntries("event")).toHaveLength(1);

      await manager.removePlugin("cleanup");

      expect(registry.hasToolBacking("cleanup_greet")).toBe(false);
      expect(registry.getHookEntries("event")).toHaveLength(0);
      expect(manager.getState("cleanup")).toBeUndefined();
    });

    it("unregisters route backings for routeSpec plugins", async () => {
      const entry = writePlugin(tmpDir, BASIC_PLUGIN);
      const manager = new NativePluginManager(makeConfig([]), registry, eventBus, {});

      await manager.addPlugin(
        {
          name: "route-cleanup",
          entry,
          exportType: "opencode-plugin",
          prefix: true,
        },
        { routeKey: "env_987", worktreePrefix: "/tmp/worktrees/env_987/repo" },
      );
      expect(registry.getRouteKeys("route-cleanup_echo")).toEqual(["env_987"]);

      await manager.removePlugin("route-cleanup");

      expect(registry.getRouteKeys("route-cleanup_echo")).toEqual([]);
    });

    it("calls dispose on plugin removal", async () => {
      const pluginCode = `
        export default async () => ({
          tool: {},
          dispose: async () => { globalThis.__removedDisposed = true; },
        });
      `;
      const entry = writePlugin(tmpDir, pluginCode);
      const manager = new NativePluginManager(makeConfig([]), registry, eventBus, {});

      await manager.addPlugin({
        name: "dispose-on-remove",
        entry,
        exportType: "opencode-plugin",
        prefix: true,
      });

      await manager.removePlugin("dispose-on-remove");
      expect((globalThis as Record<string, unknown>).__removedDisposed).toBe(true);
      delete (globalThis as Record<string, unknown>).__removedDisposed;
    });

    it("stops and removes per-plugin watcher", async () => {
      const originalStop = FileWatcher.prototype.stop;
      let stopCalls = 0;
      FileWatcher.prototype.stop = function stopPatched(this: FileWatcher): void {
        stopCalls++;
        return originalStop.call(this);
      };

      const entry = writePlugin(tmpDir, BASIC_PLUGIN);
      const manager = new NativePluginManager(makeConfig([]), registry, eventBus, {});

      try {
        await manager.addPlugin({
          name: "watch-stop",
          entry,
          watchDir: tmpDir,
          exportType: "opencode-plugin",
          prefix: true,
        });

        await manager.removePlugin("watch-stop");
        expect(stopCalls).toBe(1);
      } finally {
        FileWatcher.prototype.stop = originalStop;
      }
    });
  });

  describe("dependency cascading", () => {
    it("reloads dependents when dependency is reloaded", async () => {
      const dirA = makeTmpWithNodeModules();
      const dirB = makeTmpWithNodeModules();


      try {
        const entryA = writePlugin(dirA, BASIC_PLUGIN);
        const entryB = writePlugin(
          dirB,
          `
          import { z } from "zod";
          export default async () => ({
            tool: {
              upper: {
                description: "Uppercases",
                args: { text: z.string() },
                execute: async (args) => args.text.toUpperCase(),
              },
            },
          });
        `,
        );

        const config = makeConfig([
          { name: "base", entry: entryA, watchDir: dirA },
          { name: "dependent", entry: entryB, watchDir: dirB, dependsOn: ["base"] },
        ]);
        const manager = new NativePluginManager(config, registry, eventBus, {});
        await manager.loadAll();

        const baseReloads = manager.getState("base")?.reloadCount ?? 0;
        const depReloads = manager.getState("dependent")?.reloadCount ?? 0;

        await manager.reloadPlugin("base");

        expect(manager.getState("base")?.reloadCount).toBe(baseReloads + 1);
        expect(manager.getState("dependent")?.reloadCount).toBe(depReloads + 1);
      } finally {
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    });
  });

  describe("getStatus", () => {
    it("returns status for all plugins", async () => {
      const entry = writePlugin(tmpDir, BASIC_PLUGIN);
      const config = makeConfig([
        { name: "test", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});
      await manager.loadAll();

      const status = manager.getStatus();
      expect(status.test).toBeDefined();
      expect(status.test.status).toBe("loaded");
      expect(status.test.toolNames).toContain("test_echo");
    });
  });

  describe("dispose", () => {
    it("clears all state and stops watchers", async () => {
      const entry = writePlugin(tmpDir, BASIC_PLUGIN);
      const config = makeConfig([
        { name: "test", entry, watchDir: tmpDir },
      ]);
      const manager = new NativePluginManager(config, registry, eventBus, {});
      await manager.loadAll();
      manager.startWatchers(() => {});

      await manager.dispose();

      expect(registry.hasToolBacking("test_echo")).toBe(false);
      expect(manager.getState("test")).toBeUndefined();
    });
  });
});
