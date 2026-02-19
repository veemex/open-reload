import { describe, expect, it } from "bun:test";
import { ToolRouter } from "../src/brain/router/tool-router.ts";
import type { ManagedTool } from "../src/brain/config/types.ts";

function mockTool(
  name: string,
  options: { pluginName?: string; namespace?: string; agentVisibility?: string[] } = {}
): ManagedTool {
  const pluginName = options.pluginName ?? "test";
  return {
    qualifiedName: `${pluginName}_${name}`,
    originalName: name,
    pluginName,
    namespace: options.namespace,
    agentVisibility: options.agentVisibility,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    zodInputSchema: undefined,
    execute: async (input) => JSON.stringify(input),
  };
}

describe("namespace routing", () => {
  it("tools filtered by namespace", () => {
    const router = new ToolRouter([
      mockTool("alphaTool", { namespace: "alpha" }),
      mockTool("betaTool", { namespace: "beta" }),
      mockTool("globalTool"),
    ]);

    const specs = router.listSpecs({ namespace: "alpha" });
    expect(specs.map((spec) => spec.name)).toEqual([
      "test_alphaTool",
      "test_globalTool",
    ]);
  });

  it("tools filtered by agentVisibility", () => {
    const router = new ToolRouter([
      mockTool("agentAOnly", { agentVisibility: ["agent-a"] }),
      mockTool("agentBOnly", { agentVisibility: ["agent-b"] }),
      mockTool("shared"),
    ]);

    const specs = router.listSpecs({ agentId: "agent-a" });
    expect(specs.map((spec) => spec.name)).toEqual([
      "test_agentAOnly",
      "test_shared",
    ]);
  });

  it("no namespace means visible to all", () => {
    const router = new ToolRouter([
      mockTool("noNamespace"),
      mockTool("alphaTool", { namespace: "alpha" }),
    ]);

    const specs = router.listSpecs({ namespace: "beta" });
    expect(specs.map((spec) => spec.name)).toEqual(["test_noNamespace"]);
  });

  it("callTool works regardless of namespace", async () => {
    const router = new ToolRouter([
      mockTool("privateAlpha", { namespace: "alpha", agentVisibility: ["agent-a"] }),
    ]);

    await expect(
      router.route({
        name: "test_privateAlpha",
        arguments: { ok: true },
        context: { cwd: process.cwd(), agentId: "agent-b" },
      })
    ).resolves.toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
  });

  it("combined namespace + agentVisibility filtering", () => {
    const router = new ToolRouter([
      mockTool("alphaA", { namespace: "alpha", agentVisibility: ["agent-a"] }),
      mockTool("alphaB", { namespace: "alpha", agentVisibility: ["agent-b"] }),
      mockTool("betaA", { namespace: "beta", agentVisibility: ["agent-a"] }),
      mockTool("global"),
    ]);

    const specs = router.listSpecs({ namespace: "alpha", agentId: "agent-a" });
    expect(specs.map((spec) => spec.name)).toEqual([
      "test_alphaA",
      "test_global",
    ]);
  });
});
