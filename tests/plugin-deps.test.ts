import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../src/brain/config/loader.ts";
import { factory } from "../src/brain/entry.ts";
import type { PluginConfig } from "../src/brain/config/types.ts";
import type { BrainContext } from "../src/shell/brain-api.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `plugin-deps-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function makePluginConfig(
  name: string,
  entry: string,
  watchDir: string,
  dependsOn?: string[]
): PluginConfig {
  return {
    name,
    entry,
    watchDir,
    exportType: "opencode-plugin",
    dependsOn,
  };
}

function makeBrainContext(logs: string[]): BrainContext {
  return {
    cwd: process.cwd(),
    nowMs: () => Date.now(),
    logErr: (line: string) => {
      logs.push(line);
    },
  };
}

function writePlugin(dir: string, pluginName: string, orderLogPath: string): string {
  const pluginPath = join(dir, "plugin.ts");
  const source = `
const fs = require("fs");

export default async () => {
  fs.appendFileSync(${JSON.stringify(orderLogPath)}, ${JSON.stringify(`${pluginName}:load\n`)});
  return {
    tool: {
      ping: {
        description: "ping",
        execute: async () => "ok",
      },
    },
  };
};
`;
  writeFileSync(pluginPath, source);
  return pluginPath;
}

function writeConfigFile(rootDir: string, plugins: PluginConfig[]): string {
  const configDir = join(rootDir, ".opencode");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "open-reload.json");
  writeFileSync(configPath, JSON.stringify({ plugins, debounceMs: 0 }));
  return configPath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("plugin dependencies", () => {
  it("plugins load in dependency order", async () => {
    const root = makeTempDir("order");
    const orderLogPath = join(root, "order.log");

    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    const entryA = writePlugin(dirA, "a", orderLogPath);
    const entryB = writePlugin(dirB, "b", orderLogPath);

    const plugins: PluginConfig[] = [
      makePluginConfig("a", entryA, dirA, ["b"]),
      makePluginConfig("b", entryB, dirB),
    ];

    const logs: string[] = [];
    const brain = await factory.create(makeBrainContext(logs), {
      configPath: writeConfigFile(root, plugins),
    });

    const order = readFileSync(orderLogPath, "utf-8")
      .split("\n")
      .filter(Boolean);

    expect(order).toEqual(["b:load", "a:load"]);
    await brain.dispose();
  });

  it("circular dependency detected and reported", async () => {
    const root = makeTempDir("cycle");
    const orderLogPath = join(root, "order.log");

    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    const entryA = writePlugin(dirA, "a", orderLogPath);
    const entryB = writePlugin(dirB, "b", orderLogPath);

    const plugins: PluginConfig[] = [
      makePluginConfig("a", entryA, dirA, ["b"]),
      makePluginConfig("b", entryB, dirB, ["a"]),
    ];

    await expect(
      factory.create(makeBrainContext([]), {
        configPath: writeConfigFile(root, plugins),
      })
    ).rejects.toThrow("Circular dependency detected");
  });

  it("dependent reloads when dependency reloads", async () => {
    const root = makeTempDir("reload");
    const orderLogPath = join(root, "order.log");

    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    const entryA = writePlugin(dirA, "a", orderLogPath);
    const entryB = writePlugin(dirB, "b", orderLogPath);

    const plugins: PluginConfig[] = [
      makePluginConfig("a", entryA, dirA),
      makePluginConfig("b", entryB, dirB, ["a"]),
    ];

    const logs: string[] = [];
    const brain = await factory.create(makeBrainContext(logs), {
      configPath: writeConfigFile(root, plugins),
    });

    logs.length = 0;
    writeFileSync(entryA, `${readFileSync(entryA, "utf-8")}\n// touch`);

    await brain.onFileEvents([{ path: entryA, kind: "change" }]);

    const reloaded = logs.filter((line) => line.startsWith("Plugin reloaded:"));
    expect(reloaded).toEqual(["Plugin reloaded: a", "Plugin reloaded: b"]);
    expect(reloaded.filter((line) => line === "Plugin reloaded: b")).toHaveLength(1);
    await brain.dispose();
  });

  it("plugins without dependencies work unchanged", async () => {
    const root = makeTempDir("independent");
    const orderLogPath = join(root, "order.log");

    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    const entryA = writePlugin(dirA, "a", orderLogPath);
    const entryB = writePlugin(dirB, "b", orderLogPath);

    const plugins: PluginConfig[] = [
      makePluginConfig("a", entryA, dirA),
      makePluginConfig("b", entryB, dirB),
    ];

    const logs: string[] = [];
    const brain = await factory.create(makeBrainContext(logs), {
      configPath: writeConfigFile(root, plugins),
    });

    logs.length = 0;
    await brain.onFileEvents([{ path: entryA, kind: "change" }]);

    expect(logs.some((line) => line.includes("Plugin reloaded: a"))).toBe(true);
    expect(logs.some((line) => line.includes("Plugin reloaded: b"))).toBe(false);
    await brain.dispose();
  });

  it("missing dependency detected", async () => {
    const root = makeTempDir("missing");
    const orderLogPath = join(root, "order.log");

    const dirA = join(root, "a");
    mkdirSync(dirA, { recursive: true });

    const entryA = writePlugin(dirA, "a", orderLogPath);
    const plugins: PluginConfig[] = [
      makePluginConfig("a", entryA, dirA, ["c"]),
    ];

    await expect(loadConfig(writeConfigFile(root, plugins))).rejects.toThrow(
      "missing dependency \"c\""
    );
  });
});
