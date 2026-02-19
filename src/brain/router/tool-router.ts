import type { ToolSpec, ToolCall, ToolResult } from "../../shell/brain-api.ts";
import type { ManagedTool } from "../config/types.ts";

export class ToolRouter {
  private routes: Map<string, ManagedTool> = new Map();

  constructor(tools: ManagedTool[] = []) {
    this.rebuild(tools);
  }

  rebuild(tools: ManagedTool[]): void {
    this.routes.clear();
    for (const tool of tools) {
      this.routes.set(tool.qualifiedName, tool);
    }
  }

  async route(call: ToolCall): Promise<ToolResult> {
    const tool = this.routes.get(call.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${call.name}` }],
        isError: true,
      };
    }

    try {
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      const result = await tool.execute(args, call.context);
      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  listSpecs(): ToolSpec[] {
    return Array.from(this.routes.values()).map((tool) => ({
      name: tool.qualifiedName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
}
