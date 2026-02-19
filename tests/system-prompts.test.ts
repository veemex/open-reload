import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { factory } from "../src/brain/entry.ts";
import type { BrainContext, PromptSpec } from "../src/shell/brain-api.ts";
import type { PluginConfig } from "../src/brain/config/types.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(resolve(import.meta.dir, `.tmp-system-prompts-${prefix}-`));
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

function writeConfigFile(
  dir: string,
  plugins: PluginConfig[],
  extra?: Record<string, unknown>
): string {
  const configDir = join(dir, ".opencode");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "open-reload.json");
  writeFileSync(configPath, JSON.stringify({ plugins, debounceMs: 0, ...extra }));
  return configPath;
}

function makeBrainContext(): BrainContext {
  return {
    cwd: process.cwd(),
    nowMs: () => Date.now(),
    logErr: () => {},
  };
}

const MINIMAL_PLUGIN = `
export default async () => ({
  tool: { noop: { execute: async () => "ok" } },
});
`;

const PLUGIN_WITH_PROMPT = `
export default async () => ({
  tool: { noop: { execute: async () => "ok" } },
  prompt: {
    "plugin-prompt": {
      description: "From plugin",
      get: async () => [{ role: "user", content: { type: "text", text: "plugin content" } }],
    },
  },
});
`;

describe("Brain-level system prompts", () => {
  it("config system prompts registered with system: prefix", async () => {
    const dir = makeTempDir("prefix");
    const pluginPath = writePlugin(dir, MINIMAL_PLUGIN);

    const configPath = writeConfigFile(
      dir,
      [{ name: "basic", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir }],
      {
        systemPrompts: [
          { name: "coding-style", content: "Always use TypeScript strict mode" },
          { name: "tone", content: "Be concise and direct" },
        ],
      }
    );

    const brain = await factory.create(makeBrainContext(), { configPath });
    const prompts = (await brain.listPrompts?.()) ?? [];
    const names = prompts.map((p) => p.name);

    expect(names).toContain("system:coding-style");
    expect(names).toContain("system:tone");
  });

  it("plugin prompts merged with config prompts", async () => {
    const dir = makeTempDir("merge");
    const pluginPath = writePlugin(dir, PLUGIN_WITH_PROMPT);

    const configPath = writeConfigFile(
      dir,
      [{ name: "merger", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir }],
      {
        systemPrompts: [
          { name: "rules", content: "Follow the rules" },
        ],
      }
    );

    const brain = await factory.create(makeBrainContext(), { configPath });
    const prompts = (await brain.listPrompts?.()) ?? [];
    const names = prompts.map((p) => p.name);

    expect(names).toContain("system:rules");
    expect(names).toContain("plugin-prompt");
    expect(prompts.length).toBe(2);
  });

  it("priority ordering works", async () => {
    const dir = makeTempDir("priority");
    const pluginPath = writePlugin(dir, MINIMAL_PLUGIN);

    const configPath = writeConfigFile(
      dir,
      [{ name: "prio", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir }],
      {
        systemPrompts: [
          { name: "low", content: "Low priority", priority: 1 },
          { name: "high", content: "High priority", priority: 100 },
          { name: "medium", content: "Medium priority", priority: 50 },
        ],
      }
    );

    const brain = await factory.create(makeBrainContext(), { configPath });
    const prompts = (await brain.listPrompts?.()) ?? [];
    const systemNames = prompts
      .filter((p) => p.name.startsWith("system:"))
      .map((p) => p.name);

    expect(systemNames).toEqual(["system:high", "system:medium", "system:low"]);
  });

  it("getPrompt returns system prompt content", async () => {
    const dir = makeTempDir("get");
    const pluginPath = writePlugin(dir, MINIMAL_PLUGIN);

    const configPath = writeConfigFile(
      dir,
      [{ name: "getter", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir }],
      {
        systemPrompts: [
          { name: "instructions", content: "You are a helpful coding assistant" },
        ],
      }
    );

    const brain = await factory.create(makeBrainContext(), { configPath });
    const messages = await brain.getPrompt?.("system:instructions");

    expect(messages).toEqual([
      { role: "user", content: { type: "text", text: "You are a helpful coding assistant" } },
    ]);
  });

  it("no system prompts = only plugin prompts", async () => {
    const dir = makeTempDir("no-sys");
    const pluginPath = writePlugin(dir, PLUGIN_WITH_PROMPT);

    const configPath = writeConfigFile(
      dir,
      [{ name: "plain", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir }],
    );

    const brain = await factory.create(makeBrainContext(), { configPath });
    const prompts = (await brain.listPrompts?.()) ?? [];

    expect(prompts).toEqual([
      { name: "plugin-prompt", description: "From plugin" },
    ]);
  });

  it("getPrompt throws for unknown system prompt", async () => {
    const dir = makeTempDir("unknown");
    const pluginPath = writePlugin(dir, MINIMAL_PLUGIN);

    const configPath = writeConfigFile(
      dir,
      [{ name: "base", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir }],
      {
        systemPrompts: [
          { name: "exists", content: "I exist" },
        ],
      }
    );

    const brain = await factory.create(makeBrainContext(), { configPath });
    expect(brain.getPrompt?.("system:nonexistent")).rejects.toThrow("Unknown prompt");
  });

  it("config validation rejects invalid systemPrompts", async () => {
    const dir = makeTempDir("invalid");
    const pluginPath = writePlugin(dir, MINIMAL_PLUGIN);

    const configDir = join(dir, ".opencode");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "open-reload.json");

    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [{ name: "val", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir }],
        systemPrompts: [{ name: "", content: "missing name" }],
      })
    );

    await expect(factory.create(makeBrainContext(), { configPath })).rejects.toThrow(
      '"name" is required'
    );

    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [{ name: "val", entry: pluginPath, exportType: "opencode-plugin", watchDir: dir }],
        systemPrompts: [{ name: "good", content: "" }],
      })
    );

    await expect(factory.create(makeBrainContext(), { configPath })).rejects.toThrow(
      '"content" is required'
    );
  });
});
