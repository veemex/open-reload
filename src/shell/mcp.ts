import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { BrainAPI, ToolSpec } from "./brain-api.ts";
import { handleStatusCall, type ShellStatus } from "./core-tools.ts";

type RegisteredTool = ReturnType<McpServer["registerTool"]>;
type RegisteredResource = { remove(): void };
type RegisteredPrompt = { remove(): void };
type McpInputSchema = Parameters<McpServer["registerTool"]>[1]["inputSchema"];

export type McpHandle = {
  server: McpServer;
  syncBrainTools(): Promise<void>;
  syncBrainResources(): Promise<void>;
  syncBrainPrompts(): Promise<void>;
  close(): Promise<void>;
};

export async function startMcpServer(opts: {
  getActiveBrain: () => BrainAPI | null;
  onReloadRequest: () => Promise<void>;
  getStatus: () => ShellStatus;
  getCwd?: () => string;
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
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
    }
  );

  const brainToolHandles: RegisteredTool[] = [];
  const brainResourceHandles: RegisteredResource[] = [];
  const brainPromptHandles: RegisteredPrompt[] = [];

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
      const schema = tool.zodInputSchema as McpInputSchema | undefined;
      const registered = server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: schema ?? z.record(z.string(), z.unknown()),
        },
        async (args) =>
          brain.callTool({
            name: tool.name,
            arguments: args,
            context: { cwd: opts.getCwd?.() ?? process.cwd() },
          })
      );
      brainToolHandles.push(registered);
    }

    await server.sendToolListChanged();
  };

  const syncBrainResources = async (): Promise<void> => {
    for (const handle of brainResourceHandles.splice(0, brainResourceHandles.length)) {
      handle.remove();
    }

    const brain = opts.getActiveBrain();
    if (!brain || !brain.listResources || !brain.readResource) {
      server.sendResourceListChanged();
      return;
    }

    const resources = await brain.listResources();
    for (const resource of resources) {
      const registered = server.registerResource(
        resource.name,
        resource.uri,
        {
          description: resource.description,
          mimeType: resource.mimeType,
        },
        async (uri) => {
          const content = await brain.readResource(uri.toString());
          return {
            contents: [
              {
                uri: content.uri,
                text: content.text,
                blob: content.blob,
                mimeType: content.mimeType,
              },
            ],
          };
        }
      );
      brainResourceHandles.push(registered);
    }

    server.sendResourceListChanged();
  };

  const syncBrainPrompts = async (): Promise<void> => {
    for (const handle of brainPromptHandles.splice(0, brainPromptHandles.length)) {
      handle.remove();
    }

    const brain = opts.getActiveBrain();
    if (!brain || !brain.listPrompts || !brain.getPrompt) {
      server.sendPromptListChanged();
      return;
    }

    const prompts = await brain.listPrompts();
    for (const prompt of prompts) {
      const argsSchema: Record<string, z.ZodString> = {};
      if (prompt.arguments) {
        for (const arg of prompt.arguments) {
          argsSchema[arg.name] = arg.required
            ? z.string().describe(arg.description ?? "")
            : z.string().optional().describe(arg.description ?? "") as unknown as z.ZodString;
        }
      }

      const hasArgs = prompt.arguments && prompt.arguments.length > 0;
      const registered = server.registerPrompt(
        prompt.name,
        {
          description: prompt.description,
          ...(hasArgs ? { argsSchema } : {}),
        },
        async (args) => {
          const result = await brain.getPrompt!(prompt.name, args as Record<string, string> | undefined);
          return {
            messages: result.map((msg) => ({
              role: msg.role,
              content: msg.content,
            })),
          };
        }
      );
      brainPromptHandles.push(registered);
    }

    server.sendPromptListChanged();
  };

  await server.connect(opts.transport ?? new StdioServerTransport());
  await syncBrainTools();
  await syncBrainResources();
  await syncBrainPrompts();

  return {
    server,
    syncBrainTools,
    syncBrainResources,
    syncBrainPrompts,
    close: async () => {
      for (const handle of brainToolHandles.splice(0, brainToolHandles.length)) {
        handle.remove();
      }
      for (const handle of brainResourceHandles.splice(0, brainResourceHandles.length)) {
        handle.remove();
      }
      for (const handle of brainPromptHandles.splice(0, brainPromptHandles.length)) {
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
