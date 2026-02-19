import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { z } from "zod";
import type { PluginConfig } from "../src/brain/config/types.ts";
import { loadPluginModule } from "../src/brain/loader/module-loader.ts";
import { ToolRouter } from "../src/brain/router/tool-router.ts";

const tempDirs: string[] = [];
const MOCK_OC_PLUGIN_DIR = resolve(import.meta.dir, "..", "dev", "mock-opencode-plugin");

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "schema-passthrough-test-"));
  tempDirs.push(dir);
  return dir;
}

function writePluginFile(dir: string, source: string): string {
  const pluginPath = join(dir, "plugin.ts");
  writeFileSync(pluginPath, source);
  return pluginPath;
}

function makeConfig(
  entry: string,
  exportType: PluginConfig["exportType"],
  name = "schema"
): PluginConfig {
  return {
    name,
    entry,
    exportType,
  };
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("schema passthrough", () => {
  it("stores native zodInputSchema for opencode-plugin args", async () => {
    const pluginPath = resolve(MOCK_OC_PLUGIN_DIR, "index.ts");

    const { tools } = await loadPluginModule(makeConfig(pluginPath, "opencode-plugin", "mockoc"));
    const greet = tools.find((tool) => tool.originalName === "greet");

    expect(greet?.zodInputSchema).toBeDefined();
    const json = z.toJSONSchema(greet?.zodInputSchema as z.ZodTypeAny) as Record<
      string,
      unknown
    >;
    expect(json.type).toBe("object");
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.name?.description).toBe("Person's name");
  });

  it("keeps zodInputSchema undefined when opencode-plugin tool has no args", async () => {
    const tempDir = makeTempDir();
    const pluginPath = writePluginFile(
      tempDir,
      `
export default async () => ({
  tool: {
    ping: {
      description: "No args tool",
      execute: async () => "pong",
    },
  },
});
`
    );

    const { tools } = await loadPluginModule(makeConfig(pluginPath, "opencode-plugin", "oc"));
    const ping = tools.find((tool) => tool.originalName === "ping");

    expect(ping?.zodInputSchema).toBeUndefined();
  });

  it("builds zodInputSchema from tool-array JSON Schema", async () => {
    const tempDir = makeTempDir();
    const pluginPath = writePluginFile(
      tempDir,
      `
export const tools = [
  {
    name: "search",
    description: "Searches records",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    execute: async (input) => String(input.query ?? ""),
  },
];
`
    );

    const { tools } = await loadPluginModule(makeConfig(pluginPath, "tool-array", "arr"));
    const search = tools.find((tool) => tool.originalName === "search");

    expect(search?.zodInputSchema).toBeDefined();
    const json = z.toJSONSchema(search?.zodInputSchema as z.ZodTypeAny) as Record<
      string,
      unknown
    >;
    expect(json.type).toBe("object");
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.query?.type).toBe("string");
  });

  it("preserves zodInputSchema through ToolRouter.listSpecs", async () => {
    const pluginPath = resolve(MOCK_OC_PLUGIN_DIR, "index.ts");

    const { tools } = await loadPluginModule(makeConfig(pluginPath, "opencode-plugin", "mockoc"));
    const router = new ToolRouter(tools);
    const [spec] = router
      .listSpecs()
      .filter((entry) => entry.name === "mockoc_greet");

    const greet = tools.find((tool) => tool.qualifiedName === "mockoc_greet");

    expect(spec.zodInputSchema).toBeDefined();
    expect(spec.zodInputSchema).toBe(greet?.zodInputSchema);
  });
});
