import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { factory } from "../src/brain/entry.ts";
import type { PluginConfig } from "../src/brain/config/types.ts";
import type { BrainContext } from "../src/shell/brain-api.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `persist-test-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function writeSimplePlugin(dir: string): string {
  const pluginPath = join(dir, "plugin.ts");
  writeFileSync(
    pluginPath,
    `export default async () => ({
  tool: {
    hello: {
      description: "says hello",
      execute: async () => "hello",
    },
  },
});
`,
  );
  return pluginPath;
}

function makeConfig(entry: string, watchDir: string, name = "test"): PluginConfig {
  return { name, entry, exportType: "opencode-plugin", watchDir };
}

function writeConfigFile(dir: string, plugins: PluginConfig[], statePath?: string): string {
  const configDir = join(dir, ".opencode");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "open-reload.json");
  const config: Record<string, unknown> = { plugins, debounceMs: 0 };
  if (statePath !== undefined) {
    config.statePath = statePath;
  }
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function makeBrainContext(logs: string[]): BrainContext {
  return {
    cwd: process.cwd(),
    nowMs: () => Date.now(),
    logErr: (line: string) => { logs.push(line); },
  };
}

describe("persistent plugin state — disk-backed snapshots", () => {
  it("snapshot saved to disk on dispose", async () => {
    const dir = makeTempDir("save");
    const pluginPath = writeSimplePlugin(dir);
    const statePath = join(dir, "state.json");
    const configPath = writeConfigFile(dir, [makeConfig(pluginPath, dir)], statePath);

    const logs: string[] = [];
    const brain = await factory.create(makeBrainContext(logs), { configPath });

    expect(existsSync(statePath)).toBe(false);

    await brain.dispose();

    expect(existsSync(statePath)).toBe(true);
    const data = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(data.plugins).toBeDefined();
    expect(data.plugins.test).toBeDefined();
    expect(data.plugins.test.toolNames).toContain("hello");
  });

  it("snapshot loaded from disk on create", async () => {
    const dir = makeTempDir("load");
    const pluginPath = writeSimplePlugin(dir);
    const statePath = join(dir, "state.json");
    const configPath = writeConfigFile(dir, [makeConfig(pluginPath, dir)], statePath);

    const logs: string[] = [];
    const ctx = makeBrainContext(logs);

    const brain1 = await factory.create(ctx, { configPath });
    await brain1.dispose();

    const saved = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(saved.plugins.test.reloadCount).toBe(1);

    saved.plugins.test.reloadCount = 42;
    writeFileSync(statePath, JSON.stringify(saved));

    const brain2 = await factory.create(ctx, { configPath });
    const snapshot = await brain2.exportSnapshot();
    const plugins = snapshot as { plugins: Record<string, { reloadCount: number }> };
    expect(plugins.plugins.test.reloadCount).toBeGreaterThanOrEqual(42);
  });

  it("corrupted snapshot starts fresh", async () => {
    const dir = makeTempDir("corrupt");
    const pluginPath = writeSimplePlugin(dir);
    const statePath = join(dir, "state.json");
    const configPath = writeConfigFile(dir, [makeConfig(pluginPath, dir)], statePath);

    writeFileSync(statePath, "NOT VALID JSON {{{");

    const logs: string[] = [];
    const brain = await factory.create(makeBrainContext(logs), { configPath });

    expect(logs.some((l) => l.includes("Failed to load snapshot from disk"))).toBe(true);

    const tools = await brain.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("atomic write uses tmp file", async () => {
    const dir = makeTempDir("atomic");
    const pluginPath = writeSimplePlugin(dir);
    const statePath = join(dir, "state.json");
    const configPath = writeConfigFile(dir, [makeConfig(pluginPath, dir)], statePath);

    const logs: string[] = [];
    const brain = await factory.create(makeBrainContext(logs), { configPath });
    await brain.dispose();

    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(statePath + ".tmp")).toBe(false);
  });

  it("no statePath means no disk persistence", async () => {
    const dir = makeTempDir("no-path");
    const pluginPath = writeSimplePlugin(dir);
    const configPath = writeConfigFile(dir, [makeConfig(pluginPath, dir)]);

    const logs: string[] = [];
    const brain = await factory.create(makeBrainContext(logs), { configPath });
    await brain.dispose();

    const files = require("fs").readdirSync(dir);
    const stateFiles = files.filter((f: string) => f.endsWith(".json") && f.startsWith("state"));
    expect(stateFiles.length).toBe(0);
  });

  it("BrainSnapshot remains JSON-serializable", async () => {
    const dir = makeTempDir("serial");
    const pluginPath = writeSimplePlugin(dir);
    const statePath = join(dir, "state.json");
    const configPath = writeConfigFile(dir, [makeConfig(pluginPath, dir)], statePath);

    const logs: string[] = [];
    const brain = await factory.create(makeBrainContext(logs), { configPath });
    const snapshot = await brain.exportSnapshot();

    const serialized = JSON.stringify(snapshot);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized.includes("function")).toBe(false);
  });
});
