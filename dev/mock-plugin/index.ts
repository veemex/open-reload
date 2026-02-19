// Export format: tool-array
// export const tools = [{ name, description, inputSchema, execute }]

export const tools = [
  {
    name: "echo",
    description: "Returns the input message as-is",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to echo back" },
      },
      required: ["message"],
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      return String(input.message ?? "");
    },
  },
  {
    name: "add",
    description: "Adds two numbers and returns the result",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const a = Number(input.a ?? 0);
      const b = Number(input.b ?? 0);
      return String(a + b);
    },
  },
  {
    name: "upcase",
    description: "Converts a string to uppercase",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to uppercase" },
      },
      required: ["text"],
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      return String(input.text ?? "").toUpperCase();
    },
  },
];
