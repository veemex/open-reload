import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { loadPluginModule } from "../src/brain/loader/module-loader.ts";
import { PluginEventBus } from "../src/brain/events/event-bus.ts";
import type { PluginConfig } from "../src/brain/config/types.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(resolve(import.meta.dir, ".tmp-event-bus-"));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(name: string, entry: string): PluginConfig {
  return {
    name,
    entry,
    exportType: "opencode-plugin",
  };
}

function writePlugin(dir: string, fileName: string, source: string): string {
  const pluginPath = join(dir, fileName);
  writeFileSync(pluginPath, source);
  return pluginPath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("PluginEventBus", () => {
  it("plugin A emits event received by plugin B", async () => {
    const dir = makeTempDir();
    const eventBus = new PluginEventBus();

    const pluginAPath = writePlugin(
      dir,
      "plugin-a.ts",
      `export default async () => ({
  tool: {
    emit_environment_created: {
      description: "emit environment.created",
      execute: async (_args, context) => {
        await context.events.emit("environment.created", { envId: "env_1" });
        return "emitted";
      },
    },
  },
});
`
    );

    const pluginBPath = writePlugin(
      dir,
      "plugin-b.ts",
      `let eventCount = 0;

export default async () => ({
  tool: {
    subscribe_environment_created: {
      description: "subscribe to environment.created",
      execute: async (_args, context) => {
        context.events.on("environment.created", () => {
          eventCount += 1;
        });
        return "subscribed";
      },
    },
    get_event_count: {
      description: "read event count",
      execute: async () => String(eventCount),
    },
  },
});
`
    );

    const pluginA = await loadPluginModule(makeConfig("a", pluginAPath), eventBus);
    const pluginB = await loadPluginModule(makeConfig("b", pluginBPath), eventBus);

    const subscribe = pluginB.tools.find((tool) => tool.originalName === "subscribe_environment_created");
    const emit = pluginA.tools.find((tool) => tool.originalName === "emit_environment_created");
    const getCount = pluginB.tools.find((tool) => tool.originalName === "get_event_count");

    await subscribe!.execute({});
    await emit!.execute({});

    expect(await getCount!.execute({})).toBe("1");
  });

  it("handlers cleaned up on plugin dispose", async () => {
    const eventBus = new PluginEventBus();
    let calls = 0;

    eventBus.on("environment.created", () => {
      calls += 1;
    }, "plugin-b");

    eventBus.removePlugin("plugin-b");
    await eventBus.emit({
      source: "plugin-a",
      type: "environment.created",
      payload: { envId: "env_1" },
      timestamp: Date.now(),
    });

    expect(calls).toBe(0);
  });

  it("emit error in one handler doesn't block others", async () => {
    const eventBus = new PluginEventBus();
    let calls = 0;

    eventBus.on("environment.created", () => {
      throw new Error("boom");
    });
    eventBus.on("environment.created", () => {
      calls += 1;
    });

    await eventBus.emit({
      source: "plugin-a",
      type: "environment.created",
      payload: null,
      timestamp: Date.now(),
    });

    expect(calls).toBe(1);
  });

  it("unsubscribe function works", async () => {
    const eventBus = new PluginEventBus();
    let calls = 0;

    const unsubscribe = eventBus.on("environment.created", () => {
      calls += 1;
    });

    unsubscribe();
    await eventBus.emit({
      source: "plugin-a",
      type: "environment.created",
      payload: null,
      timestamp: Date.now(),
    });

    expect(calls).toBe(0);
  });

  it("clear removes all handlers", async () => {
    const eventBus = new PluginEventBus();
    let calls = 0;

    eventBus.on("environment.created", () => {
      calls += 1;
    }, "plugin-a");
    eventBus.on("environment.created", () => {
      calls += 1;
    }, "plugin-b");

    eventBus.clear();
    await eventBus.emit({
      source: "plugin-c",
      type: "environment.created",
      payload: null,
      timestamp: Date.now(),
    });

    expect(calls).toBe(0);
  });
});
