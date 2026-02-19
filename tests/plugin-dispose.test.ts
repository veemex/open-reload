import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPluginModule } from "../src/brain/loader/module-loader.ts";
import { factory } from "../src/brain/entry.ts";
import type { PluginConfig } from "../src/brain/config/types.ts";
import type { BrainContext } from "../src/shell/brain-api.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dispose-test-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function writeDisposePlugin(dir: string, disposeBody: string): string {
  const pluginPath = join(dir, "plugin.ts");
  const source = `
let disposeLog: string[] = [];

export default async () => ({
  tool: {
    noop: {
      description: "does nothing",
      execute: async () => "ok",
    },
  },
  dispose: async () => {
    ${disposeBody}
  },
});
`;
  writeFileSync(pluginPath, source);
  return pluginPath;
}

function writePluginWithoutDispose(dir: string): string {
  const pluginPath = join(dir, "plugin.ts");
  const source = `
export default async () => ({
  tool: {
    noop: {
      description: "does nothing",
      execute: async () => "ok",
    },
  },
});
`;
  writeFileSync(pluginPath, source);
  return pluginPath;
}

function makeConfig(entry: string, watchDir: string, name = "test"): PluginConfig {
  return { name, entry, exportType: "opencode-plugin", watchDir };
}

function writeConfigFile(dir: string, plugins: PluginConfig[]): string {
  const configDir = join(dir, ".opencode");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "open-reload.json");
  writeFileSync(configPath, JSON.stringify({ plugins, debounceMs: 0 }));
  return configPath;
}

function makeBrainContext(logs: string[]): BrainContext {
  return {
    cwd: process.cwd(),
    nowMs: () => Date.now(),
    logErr: (line: string) => { logs.push(line); },
  };
}

describe("plugin dispose — module loader extraction", () => {
  it("extracts dispose from opencode-plugin result", async () => {
    const dir = makeTempDir("extract");
    const pluginPath = writeDisposePlugin(dir, "/* noop */");
    const config: PluginConfig = { name: "d", entry: pluginPath, exportType: "opencode-plugin" };

    const result = await loadPluginModule(config);

    expect(result.tools.length).toBe(1);
    expect(typeof result.dispose).toBe("function");
  });

  it("returns undefined dispose when plugin has no dispose", async () => {
    const dir = makeTempDir("no-dispose");
    const pluginPath = writePluginWithoutDispose(dir);
    const config: PluginConfig = { name: "nd", entry: pluginPath, exportType: "opencode-plugin" };

    const result = await loadPluginModule(config);

    expect(result.tools.length).toBe(1);
    expect(result.dispose).toBeUndefined();
  });
});

describe("plugin dispose — Brain lifecycle", () => {
  it("dispose called before plugin reload", async () => {
    const dir = makeTempDir("reload");
    const markerPath = join(dir, "disposed.txt");
    const pluginPath = writeDisposePlugin(
      dir,
      `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "disposed");`
    );
    const pluginConfig = makeConfig(pluginPath, dir, "disposable");
    const configPath = writeConfigFile(dir, [pluginConfig]);

    const logs: string[] = [];
    const ctx = makeBrainContext(logs);
    const brain = await factory.create(ctx, { configPath });

    const { existsSync } = await import("fs");
    expect(existsSync(markerPath)).toBe(false);

    await brain.onFileEvents([{ path: join(dir, "plugin.ts"), kind: "change" }]);

    expect(existsSync(markerPath)).toBe(true);
  });

  it("dispose error does not block reload", async () => {
    const dir = makeTempDir("dispose-err");
    const pluginPath = writeDisposePlugin(dir, `throw new Error("dispose-boom");`);
    const pluginConfig = makeConfig(pluginPath, dir, "crashy");
    const configPath = writeConfigFile(dir, [pluginConfig]);

    const logs: string[] = [];
    const ctx = makeBrainContext(logs);
    const brain = await factory.create(ctx, { configPath });

    await brain.onFileEvents([{ path: join(dir, "plugin.ts"), kind: "change" }]);

    expect(logs.some((l) => l.includes("dispose-boom"))).toBe(true);
    expect(logs.some((l) => l.includes("Plugin reloaded: crashy"))).toBe(true);
  });

  it("dispose called on Brain.dispose() for all plugins", async () => {
    const dir1 = makeTempDir("brain-d1");
    const dir2 = makeTempDir("brain-d2");
    const marker1 = join(dir1, "disposed.txt");
    const marker2 = join(dir2, "disposed.txt");

    const pluginPath1 = writeDisposePlugin(
      dir1,
      `require("fs").writeFileSync(${JSON.stringify(marker1)}, "d1");`
    );
    const pluginPath2 = writeDisposePlugin(
      dir2,
      `require("fs").writeFileSync(${JSON.stringify(marker2)}, "d2");`
    );

    const configDir = makeTempDir("brain-cfg");
    const configPath = writeConfigFile(configDir, [
      makeConfig(pluginPath1, dir1, "p1"),
      makeConfig(pluginPath2, dir2, "p2"),
    ]);

    const logs: string[] = [];
    const ctx = makeBrainContext(logs);
    const brain = await factory.create(ctx, { configPath });

    const { existsSync } = await import("fs");
    expect(existsSync(marker1)).toBe(false);
    expect(existsSync(marker2)).toBe(false);

    await brain.dispose();

    expect(existsSync(marker1)).toBe(true);
    expect(existsSync(marker2)).toBe(true);
    expect(logs.some((l) => l.includes("Brain disposed"))).toBe(true);
  });

  it("plugins without dispose work unchanged during reload", async () => {
    const dir = makeTempDir("no-dispose-reload");
    const pluginPath = writePluginWithoutDispose(dir);
    const pluginConfig = makeConfig(pluginPath, dir, "plain");
    const configPath = writeConfigFile(dir, [pluginConfig]);

    const logs: string[] = [];
    const ctx = makeBrainContext(logs);
    const brain = await factory.create(ctx, { configPath });

    await brain.onFileEvents([{ path: join(dir, "plugin.ts"), kind: "change" }]);

    expect(logs.some((l) => l.includes("Plugin reloaded: plain"))).toBe(true);
    expect(logs.every((l) => !l.includes("dispose failed"))).toBe(true);
  });
});

describe("plugin dispose — snapshot serialization", () => {
  it("dispose is NOT included in toSnapshot", async () => {
    const dir = makeTempDir("snapshot");
    const pluginPath = writeDisposePlugin(dir, "/* noop */");
    const pluginConfig = makeConfig(pluginPath, dir, "snap");
    const configPath = writeConfigFile(dir, [pluginConfig]);

    const logs: string[] = [];
    const ctx = makeBrainContext(logs);
    const brain = await factory.create(ctx, { configPath });
    const snapshot = await brain.exportSnapshot();
    const json = JSON.stringify(snapshot);

    expect(json.includes("dispose")).toBe(false);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
