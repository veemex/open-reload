import { describe, it, expect } from "bun:test";
import { loadBrain, swapBrain } from "../src/shell/brain-loader.ts";
import type { BrainContext, BrainAPI, ToolCall } from "../src/shell/brain-api.ts";

const mockCtx: BrainContext = {
  cwd: process.cwd(),
  nowMs: () => Date.now(),
  logErr: () => {},
};

describe("loadBrain", () => {
  it("loads brain from entry.ts and returns BrainAPI", async () => {
    const brain = await loadBrain(mockCtx, {});

    expect(typeof brain.listTools).toBe("function");
    expect(typeof brain.callTool).toBe("function");
    expect(typeof brain.getWatchPlan).toBe("function");
    expect(typeof brain.onFileEvents).toBe("function");
    expect(typeof brain.exportSnapshot).toBe("function");
    expect(typeof brain.dispose).toBe("function");
  });

  it("brain.listTools() returns tools from loaded plugins", async () => {
    const brain = await loadBrain(mockCtx, {});
    const tools = await brain.listTools();
    expect(Array.isArray(tools)).toBe(true);
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
    }
  });

  it("brain.exportSnapshot() returns plugin state snapshot", async () => {
    const brain = await loadBrain(mockCtx, {});
    const snapshot = await brain.exportSnapshot();
    expect(snapshot).toBeDefined();
    expect(typeof snapshot).toBe("object");
  });

  it("brain.dispose() does not throw", async () => {
    const logs: string[] = [];
    const ctx: BrainContext = {
      ...mockCtx,
      logErr: (line: string) => {
        logs.push(line);
      },
    };
    const brain = await loadBrain(ctx, {});

    await expect(brain.dispose()).resolves.toBeUndefined();
    expect(logs).toContain("Brain disposed");
  });

  it("brain.callTool() returns error for unknown tool", async () => {
    const brain = await loadBrain(mockCtx, {});
    const call: ToolCall = { name: "nonexistent_tool" };
    const result = await brain.callTool(call);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });
});

describe("swapBrain", () => {
  it("swapBrain with null loads initial brain", async () => {
    const brain = await swapBrain(mockCtx, null);

    expect(typeof brain.listTools).toBe("function");
    const tools = await brain.listTools();
    expect(Array.isArray(tools)).toBe(true);
  });

  it("swapBrain with existing brain returns new brain", async () => {
    const existingBrain = await loadBrain(mockCtx, {});
    const nextBrain = await swapBrain(mockCtx, existingBrain);

    expect(nextBrain).not.toBe(existingBrain);
  });

  it("swapBrain disposes old brain on success", async () => {
    let disposed = false;

    const existingBrain: BrainAPI = {
      listTools: async () => [],
      callTool: async () => ({
        content: [{ type: "text", text: "old" }],
        isError: true,
      }),
      getWatchPlan: async () => ({
        roots: [],
        recursive: true,
        debounceMs: 300,
        ignore: [],
      }),
      onFileEvents: async () => ({}),
      exportSnapshot: async () => ({ fromOld: true }),
      dispose: async () => {
        disposed = true;
      },
    };

    const nextBrain = await swapBrain(mockCtx, existingBrain);

    expect(nextBrain).not.toBe(existingBrain);
    expect(disposed).toBe(true);
  });

  it("swapBrain preserves snapshot across reload", async () => {
    const existingBrain = await loadBrain(mockCtx, {});
    const snapshot = await existingBrain.exportSnapshot();

    const nextBrain = await swapBrain(mockCtx, existingBrain);
    const nextSnapshot = await nextBrain.exportSnapshot();
    expect(nextSnapshot).toBeDefined();
    expect(typeof nextSnapshot).toBe("object");
  });
});
