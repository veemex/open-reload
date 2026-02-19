import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpServer } from "../src/shell/mcp.ts";
import type { BrainAPI, ToolSpec } from "../src/shell/brain-api.ts";

function createMockBrain(tools: ToolSpec[] = []): BrainAPI {
  return {
    listTools: async () => tools,
    callTool: async (call) => ({
      content: [
        {
          type: "text",
          text: `called:${call.name}:${JSON.stringify(call.arguments ?? {})}`,
        },
      ],
    }),
    getWatchPlan: async () => ({ roots: [], recursive: true, debounceMs: 300, ignore: [] }),
    onFileEvents: async () => ({}),
    exportSnapshot: async () => ({}),
    dispose: async () => {},
  };
}

async function setup(brain?: BrainAPI) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let activeBrain: BrainAPI | null = brain ?? null;
  let reloadCount = 0;

  const mcp = await startMcpServer({
    getActiveBrain: () => activeBrain,
    onReloadRequest: async () => {
      reloadCount++;
    },
    getStatus: () => ({
      brainLoaded: activeBrain !== null,
      lastReloadAt: null,
      lastError: null,
      reloadCount,
      pluginCount: 0,
    }),
    transport: serverTransport,
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    mcp,
    getReloadCount: () => reloadCount,
    setBrain: (b: BrainAPI | null) => {
      activeBrain = b;
    },
    cleanup: async () => {
      await client.close();
      await mcp.close();
    },
  };
}

type TestContext = Awaited<ReturnType<typeof setup>>;

function getFirstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result) || !Array.isArray(result.content)) {
    return "";
  }
  const first = result.content[0];
  if (!first || typeof first !== "object") {
    return "";
  }
  if (!("type" in first) || !("text" in first)) {
    return "";
  }
  if (first.type !== "text" || typeof first.text !== "string") {
    return "";
  }
  return first.text;
}

describe("MCP integration with InMemoryTransport", () => {
  let ctx: TestContext | null = null;

  beforeEach(() => {
    ctx = null;
  });

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it("tools/list returns core tools when brain is missing", async () => {
    ctx = await setup();

    const result = await ctx.client.listTools();
    const names = result.tools.map((tool) => tool.name);

    expect(names).toEqual(["openreload_reload", "openreload_status"]);
  });

  it("tools/list returns core + brain tools when brain is active", async () => {
    ctx = await setup(
      createMockBrain([
        {
          name: "brain_echo",
          description: "Echo tool from brain",
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
        },
      ])
    );

    const result = await ctx.client.listTools();
    const names = result.tools.map((tool) => tool.name);

    expect(names).toEqual(["openreload_reload", "openreload_status", "brain_echo"]);
  });

  it("tools/call for openreload_status works", async () => {
    ctx = await setup();

    const result = await ctx.client.callTool({ name: "openreload_status", arguments: {} });
    const text = getFirstText(result);

    expect(text).toContain("Brain loaded: false");
    expect(text).toContain("Last reload: never");
    expect(text).toContain("Reload count: 0");
  });

  it("tools/call for openreload_reload triggers callback", async () => {
    ctx = await setup();

    const result = await ctx.client.callTool({ name: "openreload_reload", arguments: {} });
    const text = getFirstText(result);

    expect(text).toBe("Brain reloaded");
    expect(ctx.getReloadCount()).toBe(1);
  });

  it("tools/call for brain tools delegates to brain.callTool", async () => {
    ctx = await setup(
      createMockBrain([
        {
          name: "brain_delegate",
          description: "Delegated tool",
          inputSchema: { type: "object", properties: { foo: { type: "string" } } },
        },
      ])
    );

    const result = await ctx.client.callTool({
      name: "brain_delegate",
      arguments: { foo: "bar" },
    });
    const text = getFirstText(result);

    expect(text).toBe('called:brain_delegate:{"foo":"bar"}');
  });

  it("syncBrainTools updates available tools dynamically", async () => {
    ctx = await setup(
      createMockBrain([
        {
          name: "brain_first",
          description: "First brain tool",
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
        },
      ])
    );

    const initialTools = await ctx.client.listTools();
    expect(initialTools.tools.map((tool) => tool.name)).toContain("brain_first");

    ctx.setBrain(
      createMockBrain([
        {
          name: "brain_second",
          description: "Second brain tool",
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
        },
      ])
    );
    await ctx.mcp.syncBrainTools();

    const updatedTools = await ctx.client.listTools();
    const names = updatedTools.tools.map((tool) => tool.name);

    expect(names).toContain("brain_second");
    expect(names).not.toContain("brain_first");
  });
});
