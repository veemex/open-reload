import { describe, it, expect } from "bun:test";
import { ToolRouter } from "../src/brain/router/tool-router.ts";
import type { ManagedTool } from "../src/brain/config/types.ts";
import type { ToolCall } from "../src/shell/brain-api.ts";

function mockTool(name: string, pluginName = "test"): ManagedTool {
  return {
    qualifiedName: `${pluginName}_${name}`,
    originalName: name,
    pluginName,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    zodInputSchema: undefined,
    execute: async (input) => JSON.stringify(input),
  };
}

describe("ToolRouter", () => {
  describe("route", () => {
    it("routes to known tool and returns result wrapped in ToolResult", async () => {
      const tool = mockTool("sum");
      const router = new ToolRouter([tool]);
      const call: ToolCall = {
        name: "test_sum",
        arguments: { a: 1, b: 2 },
      };

      await expect(router.route(call)).resolves.toEqual({
        content: [{ type: "text", text: '{"a":1,"b":2}' }],
      });
    });

    it("returns isError for unknown tool", async () => {
      const router = new ToolRouter([]);
      const call: ToolCall = { name: "missing_tool" };

      await expect(router.route(call)).resolves.toEqual({
        content: [{ type: "text", text: "Unknown tool: missing_tool" }],
        isError: true,
      });
    });

    it("catches execute errors and wraps them", async () => {
      const failingTool: ManagedTool = {
        ...mockTool("explode"),
        execute: async () => {
          throw new Error("boom");
        },
      };
      const router = new ToolRouter([failingTool]);

      await expect(router.route({ name: "test_explode", arguments: {} })).resolves.toEqual({
        content: [{ type: "text", text: "Tool error: boom" }],
        isError: true,
      });
    });
  });

  describe("rebuild", () => {
    it("replaces routing table with new tools", async () => {
      const oldTool = mockTool("first");
      const newTool = mockTool("second");
      const router = new ToolRouter([oldTool]);

      router.rebuild([newTool]);

      await expect(router.route({ name: "test_second", arguments: { ok: true } })).resolves.toEqual({
        content: [{ type: "text", text: '{"ok":true}' }],
      });
    });

    it("old tools no longer routable after rebuild", async () => {
      const router = new ToolRouter([mockTool("old")]);
      router.rebuild([mockTool("new")]);

      await expect(router.route({ name: "test_old", arguments: {} })).resolves.toEqual({
        content: [{ type: "text", text: "Unknown tool: test_old" }],
        isError: true,
      });
    });
  });

  describe("listSpecs", () => {
    it("returns ToolSpec[] from registered tools", () => {
      const router = new ToolRouter([mockTool("alpha"), mockTool("beta")]);
      const specs = router.listSpecs();

      expect(specs).toHaveLength(2);
      expect(specs.map((s) => s.name)).toEqual(["test_alpha", "test_beta"]);
    });

    it("includes name, description, inputSchema, zodInputSchema", () => {
      const router = new ToolRouter([mockTool("inspect")]);
      const [spec] = router.listSpecs();

      expect(spec).toEqual({
        name: "test_inspect",
        description: "inspect tool",
        inputSchema: { type: "object", properties: {} },
        zodInputSchema: undefined,
      });
    });

    it("returns empty array for no tools", () => {
      const router = new ToolRouter([]);

      expect(router.listSpecs()).toEqual([]);
    });
  });
});
