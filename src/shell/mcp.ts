import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { BrainAPI, ToolSpec } from "./brain-api.ts";
import { handleStatusCall, type ShellStatus } from "./core-tools.ts";

type RegisteredTool = ReturnType<McpServer["registerTool"]>;

export type McpHandle = {
  server: McpServer;
  syncBrainTools(): Promise<void>;
  close(): Promise<void>;
};

export async function startMcpServer(opts: {
  getActiveBrain: () => BrainAPI | null;
  onReloadRequest: () => Promise<void>;
  getStatus: () => ShellStatus;
  transport?: Transport;
}): Promise<McpHandle> {
  const server = new McpServer(
    {
      name: "open-reload",
      version: "0.0.1",
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
    }
  );

  const brainToolHandles: RegisteredTool[] = [];

  server.registerTool(
    "openreload_reload",
    {
      description: "Force brain reload. Works even if brain is in error state.",
      inputSchema: z.record(z.string(), z.unknown()),
    },
    async () => {
      await opts.onReloadRequest();
      return { content: [{ type: "text", text: "Brain reloaded" }] };
    }
  );

  server.registerTool(
    "openreload_status",
    {
      description: "Report brain version, last reload time, last error, and loaded plugin count.",
      inputSchema: z.record(z.string(), z.unknown()),
    },
    async () => handleStatusCall(opts.getStatus())
  );

  const syncBrainTools = async (): Promise<void> => {
    for (const handle of brainToolHandles.splice(0, brainToolHandles.length)) {
      handle.remove();
    }

    const brain = opts.getActiveBrain();
    if (!brain) {
      await server.sendToolListChanged();
      return;
    }

    const tools = await brain.listTools();
    for (const tool of tools) {
      const registered = server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: z.record(z.string(), z.unknown()),
        },
        async (args) =>
          brain.callTool({
            name: tool.name,
            arguments: args,
            context: { cwd: process.cwd() },
          })
      );
      brainToolHandles.push(registered);
    }

    await server.sendToolListChanged();
  };

  await server.connect(opts.transport ?? new StdioServerTransport());
  await syncBrainTools();

  return {
    server,
    syncBrainTools,
    close: async () => {
      for (const handle of brainToolHandles.splice(0, brainToolHandles.length)) {
        handle.remove();
      }
      await server.close();
    },
  };
}

export function mergeToolLists(
  coreTools: ToolSpec[],
  brainTools: ToolSpec[]
): ToolSpec[] {
  return [...coreTools, ...brainTools];
}
