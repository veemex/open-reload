import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPluginModule } from "../src/brain/loader/module-loader.ts";
import type { PluginConfig } from "../src/brain/config/types.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "context-threading-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeContextPlugin(dir: string): string {
  const pluginPath = join(dir, "context-plugin.ts");
  const source = `
export default async () => ({
  tool: {
    inspect_context: {
      description: "Returns context payload",
      execute: async (_args, context) =>
        JSON.stringify({
          directory: context.directory,
          worktree: context.worktree,
          sessionID: context.sessionID,
          messageID: context.messageID,
          agent: context.agent,
        }),
    },
  },
});
`;
  writeFileSync(pluginPath, source);
  return pluginPath;
}

function makeConfig(entry: string): PluginConfig {
  return {
    name: "context",
    entry,
    exportType: "opencode-plugin",
  };
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("context threading through module loader", () => {
  it("passes per-call context values to plugin execute", async () => {
    const tempDir = makeTempDir();
    const pluginPath = writeContextPlugin(tempDir);
    const { tools } = await loadPluginModule(makeConfig(pluginPath));
    const inspect = tools.find((tool) => tool.originalName === "inspect_context");

    const result = await inspect!.execute(
      {},
      { cwd: "/custom/cwd", sessionId: "test-session", agentId: "test-agent" }
    );
    const context = JSON.parse(result) as Record<string, string>;

    expect(context.directory).toBe("/custom/cwd");
    expect(context.worktree).toBe("/custom/cwd");
    expect(context.sessionID).toBe("test-session");
    expect(context.agent).toBe("test-agent");
    expect(context.messageID).toBe("open-reload");
  });

  it("falls back to default context values when none provided", async () => {
    const tempDir = makeTempDir();
    const pluginPath = writeContextPlugin(tempDir);
    const { tools } = await loadPluginModule(makeConfig(pluginPath));
    const inspect = tools.find((tool) => tool.originalName === "inspect_context");

    const result = await inspect!.execute({});
    const context = JSON.parse(result) as Record<string, string>;

    expect(context.directory).toBe(process.cwd());
    expect(context.worktree).toBe(process.cwd());
    expect(context.sessionID).toBe("open-reload");
    expect(context.agent).toBe("open-reload");
    expect(context.messageID).toBe("open-reload");
  });
});
