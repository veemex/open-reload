import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { factory } from "../src/brain/entry.ts";
import type { BrainContext, ResourceSpec } from "../src/shell/brain-api.ts";
import type { PluginConfig } from "../src/brain/config/types.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(resolve(import.meta.dir, `.tmp-mcp-resources-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function writePlugin(dir: string, source: string): string {
  const pluginPath = join(dir, "plugin.ts");
  writeFileSync(pluginPath, source);
  return pluginPath;
}

function writeConfigFile(dir: string, plugins: PluginConfig[]): string {
  const configDir = join(dir, ".opencode");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "open-reload.json");
  writeFileSync(configPath, JSON.stringify({ plugins, debounceMs: 0 }));
  return configPath;
}

function makeBrainContext(): BrainContext {
  return {
    cwd: process.cwd(),
    nowMs: () => Date.now(),
    logErr: () => {},
  };
}

function sortResources(resources: ResourceSpec[]): ResourceSpec[] {
  return resources.slice().sort((a, b) => a.uri.localeCompare(b.uri));
}

describe("MCP resources from plugin declarations", () => {
  it("plugin resources appear in listResources", async () => {
    const dir = makeTempDir("list");
    const pluginPath = writePlugin(
      dir,
      `
export default async () => ({
  tool: {
    noop: {
      description: "does nothing",
      execute: async () => "ok",
    },
  },
  resource: {
    "memory://docs/alpha": {
      description: "alpha docs",
      mimeType: "text/plain",
      read: async () => "alpha",
    },
    "memory://docs/beta": {
      description: "beta docs",
      mimeType: "text/markdown",
      read: async () => "# beta",
    },
  },
});
`
    );

    const configPath = writeConfigFile(dir, [
      { name: "resources", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir },
    ]);
    const brain = await factory.create(makeBrainContext(), { configPath });

    const resources = sortResources((await brain.listResources?.()) ?? []);
    expect(resources).toEqual([
      {
        uri: "memory://docs/alpha",
        name: "memory://docs/alpha",
        description: "alpha docs",
        mimeType: "text/plain",
      },
      {
        uri: "memory://docs/beta",
        name: "memory://docs/beta",
        description: "beta docs",
        mimeType: "text/markdown",
      },
    ]);
  });

  it("readResource returns plugin data", async () => {
    const dir = makeTempDir("read");
    const pluginPath = writePlugin(
      dir,
      `
export default async () => ({
  tool: {
    noop: {
      execute: async () => "ok",
    },
  },
  resource: {
    "memory://report": {
      description: "runtime report",
      mimeType: "text/plain",
      read: async () => "status=green",
    },
  },
});
`
    );

    const configPath = writeConfigFile(dir, [
      { name: "readable", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir },
    ]);
    const brain = await factory.create(makeBrainContext(), { configPath });

    const content = await brain.readResource?.("memory://report");
    expect(content).toEqual({
      uri: "memory://report",
      text: "status=green",
      mimeType: "text/plain",
    });
  });

  it("resources update on plugin reload", async () => {
    const dir = makeTempDir("reload");
    const pluginPath = writePlugin(
      dir,
      `
export default async () => ({
  tool: { noop: { execute: async () => "ok" } },
  resource: {
    "memory://v1": { read: async () => "one" },
  },
});
`
    );

    const configPath = writeConfigFile(dir, [
      { name: "reloadable", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir },
    ]);
    const brain = await factory.create(makeBrainContext(), { configPath });

    const beforeReload = await brain.listResources?.();
    expect(beforeReload).toEqual([{ uri: "memory://v1", name: "memory://v1" }]);

    await Bun.sleep(2);
    writeFileSync(
      pluginPath,
      `
export default async () => ({
  tool: { noop: { execute: async () => "ok" } },
  resource: {
    "memory://v2": { read: async () => "two", mimeType: "text/plain" },
  },
});
`
    );

    await brain.onFileEvents([{ path: pluginPath, kind: "change" }]);

    const afterReload = await brain.listResources?.();
    expect(afterReload).toEqual([
      { uri: "memory://v2", name: "memory://v2", mimeType: "text/plain" },
    ]);

    const reloadedContent = await brain.readResource?.("memory://v2");
    expect(reloadedContent?.text).toBe("two");
  });

  it("plugins without resources work unchanged", async () => {
    const dir = makeTempDir("tool-only");
    const pluginPath = writePlugin(
      dir,
      `
export default async () => ({
  tool: {
    ping: {
      description: "tool-only plugin",
      execute: async () => "pong",
    },
  },
});
`
    );

    const configPath = writeConfigFile(dir, [
      { name: "toolOnly", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir },
    ]);
    const brain = await factory.create(makeBrainContext(), { configPath });

    const tools = await brain.listTools();
    const resources = await brain.listResources?.();

    expect(tools.map((tool) => tool.name)).toContain("toolOnly_ping");
    expect(resources).toEqual([]);
  });
});
