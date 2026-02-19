import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpServer, type McpHandle } from "../src/shell/mcp.ts";
import type { BrainAPI, ToolCall, ToolSpec } from "../src/shell/brain-api.ts";

const TOOL: ToolSpec = {
  name: "cwd_probe",
  description: "Returns the cwd it received",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
};

function createCapturingBrain(): { brain: BrainAPI; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const brain: BrainAPI = {
    listTools: async () => [TOOL],
    callTool: async (call) => {
      calls.push(call);
      return {
        content: [{ type: "text", text: call.context?.cwd ?? "no-cwd" }],
      };
    },
    getWatchPlan: async () => ({
      roots: [],
      recursive: true,
      debounceMs: 300,
      ignore: [],
    }),
    onFileEvents: async () => ({}),
    exportSnapshot: async () => ({}),
    dispose: async () => {},
  };
  return { brain, calls };
}

async function setupWithCwd(getCwd?: () => string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { brain, calls } = createCapturingBrain();

  const mcp = await startMcpServer({
    getActiveBrain: () => brain,
    onReloadRequest: async () => {},
    getStatus: () => ({
      brainLoaded: true,
      lastReloadAt: null,
      lastError: null,
      reloadCount: 0,
      pluginCount: 1,
    }),
    getCwd,
    transport: serverTransport,
  });

  const client = new Client({ name: "cwd-test", version: "1.0.0" });
  await client.connect(clientTransport);

  return { client, mcp, calls };
}

describe("CWD forwarding from MCP handler to plugin context", () => {
  let client: Client | null = null;
  let mcp: McpHandle | null = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    if (mcp) {
      await mcp.close();
      mcp = null;
    }
  });

  it("forwards custom getCwd to brain.callTool context", async () => {
    const ctx = await setupWithCwd(() => "/custom/worktree/path");
    client = ctx.client;
    mcp = ctx.mcp;

    await client.callTool({ name: "cwd_probe", arguments: {} });

    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].context?.cwd).toBe("/custom/worktree/path");
  });

  it("defaults to process.cwd() when getCwd is not provided", async () => {
    const ctx = await setupWithCwd();
    client = ctx.client;
    mcp = ctx.mcp;

    await client.callTool({ name: "cwd_probe", arguments: {} });

    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].context?.cwd).toBe(process.cwd());
  });

  it("calls getCwd fresh on each tool invocation (not cached)", async () => {
    let callCount = 0;
    const paths = ["/first/path", "/second/path", "/third/path"];

    const ctx = await setupWithCwd(() => {
      const path = paths[callCount] ?? "/fallback";
      callCount++;
      return path;
    });
    client = ctx.client;
    mcp = ctx.mcp;

    await client.callTool({ name: "cwd_probe", arguments: {} });
    await client.callTool({ name: "cwd_probe", arguments: {} });
    await client.callTool({ name: "cwd_probe", arguments: {} });

    expect(callCount).toBe(3);
    expect(ctx.calls[0].context?.cwd).toBe("/first/path");
    expect(ctx.calls[1].context?.cwd).toBe("/second/path");
    expect(ctx.calls[2].context?.cwd).toBe("/third/path");
  });
});
