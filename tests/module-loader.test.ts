import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { loadPluginModule } from "../src/brain/loader/module-loader.ts";
import type { PluginConfig } from "../src/brain/config/types.ts";

const MOCK_PLUGIN_DIR = resolve(import.meta.dir, "..", "dev", "mock-plugin");
const MOCK_OC_PLUGIN_DIR = resolve(import.meta.dir, "..", "dev", "mock-opencode-plugin");

function makeConfig(overrides: Partial<PluginConfig> & Pick<PluginConfig, "name" | "entry" | "exportType">): PluginConfig {
  return { ...overrides };
}

describe("loadPluginModule — tool-array", () => {
  const config = makeConfig({
    name: "mock",
    entry: resolve(MOCK_PLUGIN_DIR, "index.ts"),
    exportType: "tool-array",
  });

  it("loads all tools from tool-array plugin", async () => {
    const { tools } = await loadPluginModule(config);
    expect(tools.length).toBe(3);
    const names = tools.map((t) => t.qualifiedName);
    expect(names).toContain("mock_echo");
    expect(names).toContain("mock_add");
    expect(names).toContain("mock_upcase");
  });

  it("qualifies tool names with plugin prefix", async () => {
    const { tools } = await loadPluginModule(config);
    for (const tool of tools) {
      expect(tool.qualifiedName).toStartWith("mock_");
      expect(tool.pluginName).toBe("mock");
    }
  });

  it("preserves descriptions", async () => {
    const { tools } = await loadPluginModule(config);
    const echo = tools.find((t) => t.originalName === "echo");
    expect(echo?.description).toBe("Returns the input message as-is");
  });

  it("preserves inputSchema", async () => {
    const { tools } = await loadPluginModule(config);
    const add = tools.find((t) => t.originalName === "add");
    expect(add?.inputSchema).toEqual({
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    });
  });

  it("execute works correctly", async () => {
    const { tools } = await loadPluginModule(config);
    const add = tools.find((t) => t.originalName === "add");
    const result = await add!.execute({ a: 10, b: 32 });
    expect(result).toBe("42");
  });

  it("throws if tools export is not an array", async () => {
    const badConfig = makeConfig({
      name: "bad",
      entry: resolve(MOCK_OC_PLUGIN_DIR, "index.ts"),
      exportType: "tool-array",
    });
    await expect(loadPluginModule(badConfig)).rejects.toThrow(
      'expected "tools" export to be an array'
    );
  });
});

describe("loadPluginModule — mcp-tools", () => {
  it("throws if tools export is not an object", async () => {
    const badConfig = makeConfig({
      name: "bad",
      entry: resolve(MOCK_PLUGIN_DIR, "index.ts"),
      exportType: "mcp-tools",
    });
    await expect(loadPluginModule(badConfig)).rejects.toThrow(
      'expected "tools" export to be an object'
    );
  });
});

describe("loadPluginModule — opencode-plugin", () => {
  const config = makeConfig({
    name: "mockoc",
    entry: resolve(MOCK_OC_PLUGIN_DIR, "index.ts"),
    exportType: "opencode-plugin",
  });

  it("loads tools from opencode-plugin format", async () => {
    const { tools } = await loadPluginModule(config);
    expect(tools.length).toBe(2);
    const names = tools.map((t) => t.qualifiedName);
    expect(names).toContain("mockoc_greet");
    expect(names).toContain("mockoc_multiply");
  });

  it("qualifies tool names with plugin prefix", async () => {
    const { tools } = await loadPluginModule(config);
    for (const tool of tools) {
      expect(tool.qualifiedName).toStartWith("mockoc_");
      expect(tool.pluginName).toBe("mockoc");
    }
  });

  it("preserves descriptions", async () => {
    const { tools } = await loadPluginModule(config);
    const greet = tools.find((t) => t.originalName === "greet");
    expect(greet?.description).toBe("Greets a person by name");
  });

  it("converts Zod args to JSON Schema", async () => {
    const { tools } = await loadPluginModule(config);
    const greet = tools.find((t) => t.originalName === "greet");
    const schema = greet?.inputSchema;

    expect(schema).toBeDefined();
    expect(schema?.type).toBe("object");
    const props = schema?.properties as Record<string, unknown> | undefined;
    expect(props).toBeDefined();
    expect(props?.name).toBeDefined();
  });

  it("converts multi-arg Zod schemas correctly", async () => {
    const { tools } = await loadPluginModule(config);
    const multiply = tools.find((t) => t.originalName === "multiply");
    const schema = multiply?.inputSchema;

    expect(schema?.type).toBe("object");
    const props = schema?.properties as Record<string, Record<string, unknown>> | undefined;
    expect(props?.a).toBeDefined();
    expect(props?.b).toBeDefined();
  });

  it("execute invokes the original function with stub context", async () => {
    const { tools } = await loadPluginModule(config);
    const greet = tools.find((t) => t.originalName === "greet");
    const result = await greet!.execute({ name: "World" });
    expect(result).toBe("Hello, World!");
  });

  it("execute computes correctly for multiply", async () => {
    const { tools } = await loadPluginModule(config);
    const multiply = tools.find((t) => t.originalName === "multiply");
    const result = await multiply!.execute({ a: 7, b: 6 });
    expect(result).toBe("42");
  });

  it("throws if default export is not a function", async () => {
    const badConfig = makeConfig({
      name: "bad",
      entry: resolve(MOCK_PLUGIN_DIR, "index.ts"),
      exportType: "opencode-plugin",
    });
    await expect(loadPluginModule(badConfig)).rejects.toThrow(
      "expected default export to be a function"
    );
  });

  it("prefers 'tool' (singular) over 'tools' property", async () => {
    const { tools } = await loadPluginModule(config);
    expect(tools.length).toBe(2);
  });
});

describe("loadPluginModule — unknown exportType", () => {
  it("throws for unknown export type", async () => {
    const badConfig = {
      name: "bad",
      entry: resolve(MOCK_PLUGIN_DIR, "index.ts"),
      exportType: "banana" as PluginConfig["exportType"],
    };
    await expect(loadPluginModule(badConfig)).rejects.toThrow(
      'Unknown exportType "banana"'
    );
  });
});

describe("loadPluginModule — cache busting", () => {
  it("successive loads return fresh results", async () => {
    const config = makeConfig({
      name: "mock",
      entry: resolve(MOCK_PLUGIN_DIR, "index.ts"),
      exportType: "tool-array",
    });

    const { tools: tools1 } = await loadPluginModule(config);
    const { tools: tools2 } = await loadPluginModule(config);

    expect(tools1.length).toBe(tools2.length);
    const r1 = await tools1[1].execute({ a: 1, b: 2 });
    const r2 = await tools2[1].execute({ a: 1, b: 2 });
    expect(r1).toBe(r2);
  });
});
