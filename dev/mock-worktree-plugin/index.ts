export const tools = [
  {
    name: "echo",
    description: "Returns the input message (worktree version)",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to echo back" },
      },
      required: ["message"],
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      return `[worktree] ${String(input.message ?? "")}`;
    },
  },
];
