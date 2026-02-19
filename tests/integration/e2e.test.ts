import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { z } from "zod";
import { factory } from "../../src/brain/entry.ts";
import type { PluginConfig } from "../../src/brain/config/types.ts";
import type { BrainAPI, BrainContext } from "../../src/shell/brain-api.ts";

const tempDirs: string[] = [];
const brains: BrainAPI[] = [];
const TEST_TMP_ROOT = resolve(import.meta.dir, "..", "..", ".tmp", "integration");

function makeTempDir(prefix: string): string {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_TMP_ROOT, `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function writePluginFile(dir: string, source: string): string {
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

function makeContext(logs: string[]): BrainContext {
  return {
    cwd: process.cwd(),
    nowMs: () => Date.now(),
    logErr: (line: string) => {
      logs.push(line);
    },
  };
}

async function createBrainForPlugin(
  source: string,
  pluginName = "e2e"
): Promise<{ brain: BrainAPI; pluginPath: string; dir: string; logs: string[] }> {
  const dir = makeTempDir(pluginName);
  const pluginPath = writePluginFile(dir, source);
  const pluginConfig: PluginConfig = {
    name: pluginName,
    entry: pluginPath,
    watchDir: dir,
    exportType: "opencode-plugin",
  };
  const configPath = writeConfigFile(dir, [pluginConfig]);
  const logs: string[] = [];
  const brain = await factory.create(makeContext(logs), { configPath });
  brains.push(brain);

  return { brain, pluginPath, dir, logs };
}

function textResult(result: Awaited<ReturnType<BrainAPI["callTool"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

afterEach(async () => {
  for (const brain of brains) {
    await brain.dispose();
  }
  brains.length = 0;

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("open-reload integration e2e", () => {
  it("schema end-to-end: opencode-plugin args -> zodInputSchema", async () => {
    const source = `
import { z } from "zod";

export default async () => ({
  tool: {
    inspect: {
      description: "Schema probe",
      args: {
        query: z.string().describe("Search query"),
        limit: z.number().describe("Maximum results")
      },
      execute: async () => "ok"
    }
  }
});
`;
    const { brain } = await createBrainForPlugin(source, "schemae2e");

    const tools = await brain.listTools();
    const inspect = tools.find((tool) => tool.name === "schemae2e_inspect");

    expect(inspect).toBeDefined();
    expect(inspect?.zodInputSchema).toBeDefined();
    const zodJson = z.toJSONSchema(inspect?.zodInputSchema as z.ZodTypeAny) as Record<string, unknown>;
    const zodProps = zodJson.properties as Record<string, Record<string, unknown>>;
    expect(zodProps.query?.description).toBe("Search query");
    expect(zodProps.limit?.description).toBe("Maximum results");

    const inputSchema = inspect?.inputSchema as Record<string, unknown>;
    const inputProps = inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(inputProps.query?.description).toBe("Search query");
    expect(inputProps.limit?.description).toBe("Maximum results");
  });

  it("CWD flows through to tool execution", async () => {
    const source = `
export default async () => ({
  tool: {
    show_cwd: {
      description: "Returns execution directory",
      execute: async (_args, context) => context.directory
    }
  }
});
`;
    const { brain } = await createBrainForPlugin(source, "cwde2e");

    const result = await brain.callTool({
      name: "cwde2e_show_cwd",
      arguments: {},
      context: { cwd: "/custom/path" },
    });

    expect(result.isError).toBeUndefined();
    expect(textResult(result)).toBe("/custom/path");
  });

  it("plugin reload cycle works", async () => {
    const v1 = `
export default async () => ({
  tool: {
    version: {
      description: "Plugin version",
      execute: async () => "v1"
    }
  }
});
`;
    const v2 = `
export default async () => ({
  tool: {
    version: {
      description: "Plugin version",
      execute: async () => "v2"
    }
  }
});
`;
    const { brain, pluginPath } = await createBrainForPlugin(v1, "reloade2e");

    const before = await brain.callTool({ name: "reloade2e_version", arguments: {} });
    expect(textResult(before)).toBe("v1");

    writeFileSync(pluginPath, v2);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await brain.onFileEvents([{ path: pluginPath, kind: "change" }]);

    const after = await brain.callTool({ name: "reloade2e_version", arguments: {} });
    expect(textResult(after)).toBe("v2");
  });

  it("dispose called during reload cycle", async () => {
    const dir = makeTempDir("disposee2e");
    const markerPath = join(dir, "disposed.txt");
    const source = `
export default async () => ({
  tool: {
    noop: {
      description: "No operation",
      execute: async () => "ok"
    }
  },
  dispose: async () => {
    require("fs").writeFileSync(${JSON.stringify(markerPath)}, "disposed");
  }
});
`;

    const pluginPath = writePluginFile(dir, source);
    const pluginConfig: PluginConfig = {
      name: "disposee2e",
      entry: pluginPath,
      watchDir: dir,
      exportType: "opencode-plugin",
    };
    const configPath = writeConfigFile(dir, [pluginConfig]);
    const logs: string[] = [];
    const brain = await factory.create(makeContext(logs), { configPath });
    brains.push(brain);

    expect(existsSync(markerPath)).toBe(false);
    await brain.onFileEvents([{ path: pluginPath, kind: "change" }]);
    expect(existsSync(markerPath)).toBe(true);
  });

  it("error handling: nonexistent tool", async () => {
    const source = `
export default async () => ({
  tool: {
    ping: {
      description: "Ping",
      execute: async () => "pong"
    }
  }
});
`;
    const { brain } = await createBrainForPlugin(source, "errore2e");

    const result = await brain.callTool({ name: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(textResult(result)).toContain("Unknown tool: nonexistent");
  });

  it("error handling: throwing tool", async () => {
    const source = `
export default async () => ({
  tool: {
    explode: {
      description: "Always throws",
      execute: async () => {
        throw new Error("boom");
      }
    }
  }
});
`;
    const { brain } = await createBrainForPlugin(source, "throwe2e");

    const result = await brain.callTool({ name: "throwe2e_explode", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textResult(result)).toContain("Tool error: boom");
  });
});
