import type {
  BrainAPI,
  BrainContext,
  BrainFactory,
  BrainInit,
  BrainSnapshot,
  FileEvent,
  FileEventEffects,
  ToolCall,
  ToolResult,
  ToolSpec,
  WatchPlan,
} from "../shell/brain-api.ts";

class Brain implements BrainAPI {
  private ctx: BrainContext;
  private snapshot: BrainSnapshot;

  constructor(ctx: BrainContext, snapshot: BrainSnapshot) {
    this.ctx = ctx;
    this.snapshot = snapshot;
  }

  async listTools(): Promise<ToolSpec[]> {
    // TODO: load plugins, extract tools, return merged list
    return [];
  }

  async callTool(_call: ToolCall): Promise<ToolResult> {
    return {
      content: [{ type: "text", text: "Not implemented" }],
      isError: true,
    };
  }

  async getWatchPlan(): Promise<WatchPlan> {
    return {
      roots: [],
      recursive: true,
      debounceMs: 300,
      ignore: ["node_modules", ".git", "dist"],
    };
  }

  async onFileEvents(_events: FileEvent[]): Promise<FileEventEffects> {
    return {};
  }

  async exportSnapshot(): Promise<BrainSnapshot> {
    return { ...this.snapshot };
  }

  async dispose(): Promise<void> {
    this.ctx.logErr("Brain disposed");
  }
}

export const factory: BrainFactory = {
  async create(ctx: BrainContext, init: BrainInit): Promise<BrainAPI> {
    return new Brain(ctx, init.snapshot ?? {});
  },
};

export default factory;
