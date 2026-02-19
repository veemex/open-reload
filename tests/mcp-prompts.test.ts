import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { factory } from "../src/brain/entry.ts";
import type { BrainContext, PromptSpec } from "../src/shell/brain-api.ts";
import type { PluginConfig } from "../src/brain/config/types.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(resolve(import.meta.dir, `.tmp-mcp-prompts-${prefix}-`));
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

function sortPrompts(prompts: PromptSpec[]): PromptSpec[] {
  return prompts.slice().sort((a, b) => a.name.localeCompare(b.name));
}

describe("MCP prompts from plugin declarations", () => {
  it("plugin prompts appear in listPrompts", async () => {
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
  prompt: {
    "code-review": {
      description: "Review code for issues",
      arguments: [
        { name: "language", description: "Programming language", required: true },
        { name: "style", description: "Review style" },
      ],
      get: async (args) => [
        { role: "user", content: { type: "text", text: "Review this " + (args?.language ?? "") + " code" } },
      ],
    },
    "explain": {
      description: "Explain a concept",
      get: async () => [
        { role: "user", content: { type: "text", text: "Explain this concept" } },
      ],
    },
  },
});
`
    );

    const configPath = writeConfigFile(dir, [
      { name: "prompts", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir },
    ]);
    const brain = await factory.create(makeBrainContext(), { configPath });

    const prompts = sortPrompts((await brain.listPrompts?.()) ?? []);
    expect(prompts).toEqual([
      {
        name: "code-review",
        description: "Review code for issues",
        arguments: [
          { name: "language", description: "Programming language", required: true },
          { name: "style", description: "Review style" },
        ],
      },
      {
        name: "explain",
        description: "Explain a concept",
      },
    ]);
  });

  it("getPrompt returns correct messages", async () => {
    const dir = makeTempDir("get");
    const pluginPath = writePlugin(
      dir,
      `
export default async () => ({
  tool: {
    noop: {
      execute: async () => "ok",
    },
  },
  prompt: {
    "greet": {
      description: "Greeting prompt",
      arguments: [{ name: "name", required: true }],
      get: async (args) => [
        { role: "user", content: { type: "text", text: "Hello " + args.name } },
        { role: "assistant", content: { type: "text", text: "Hi there!" } },
      ],
    },
  },
});
`
    );

    const configPath = writeConfigFile(dir, [
      { name: "greeting", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir },
    ]);
    const brain = await factory.create(makeBrainContext(), { configPath });

    const messages = await brain.getPrompt?.("greet", { name: "World" });
    expect(messages).toEqual([
      { role: "user", content: { type: "text", text: "Hello World" } },
      { role: "assistant", content: { type: "text", text: "Hi there!" } },
    ]);
  });

  it("prompts update on plugin reload", async () => {
    const dir = makeTempDir("reload");
    const pluginPath = writePlugin(
      dir,
      `
export default async () => ({
  tool: { noop: { execute: async () => "ok" } },
  prompt: {
    "v1-prompt": {
      get: async () => [{ role: "user", content: { type: "text", text: "version one" } }],
    },
  },
});
`
    );

    const configPath = writeConfigFile(dir, [
      { name: "reloadable", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir },
    ]);
    const brain = await factory.create(makeBrainContext(), { configPath });

    const beforeReload = await brain.listPrompts?.();
    expect(beforeReload).toEqual([{ name: "v1-prompt" }]);

    await Bun.sleep(2);
    writeFileSync(
      pluginPath,
      `
export default async () => ({
  tool: { noop: { execute: async () => "ok" } },
  prompt: {
    "v2-prompt": {
      description: "updated",
      get: async () => [{ role: "user", content: { type: "text", text: "version two" } }],
    },
  },
});
`
    );

    await brain.onFileEvents([{ path: pluginPath, kind: "change" }]);

    const afterReload = await brain.listPrompts?.();
    expect(afterReload).toEqual([
      { name: "v2-prompt", description: "updated" },
    ]);

    const messages = await brain.getPrompt?.("v2-prompt");
    expect(messages).toEqual([
      { role: "user", content: { type: "text", text: "version two" } },
    ]);
  });

  it("plugins without prompts work unchanged", async () => {
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
    const prompts = await brain.listPrompts?.();

    expect(tools.map((tool) => tool.name)).toContain("toolOnly_ping");
    expect(prompts).toEqual([]);
  });
});
