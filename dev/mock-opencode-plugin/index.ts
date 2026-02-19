import { z } from "zod";

export default async () => ({
  tool: {
    greet: {
      description: "Greets a person by name",
      args: { name: z.string().describe("Person's name") },
      execute: async (args: { name: string }) => `Hello, ${args.name}!`,
    },
    multiply: {
      description: "Multiplies two numbers",
      args: {
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      },
      execute: async (args: { a: number; b: number }) =>
        String(args.a * args.b),
    },
  },
});
