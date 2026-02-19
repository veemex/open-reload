import { describe, it, expect } from "bun:test";
import {
  getCoreToolSpecs,
  isCoreToolCall,
  handleStatusCall,
  type ShellStatus,
} from "../src/shell/core-tools.ts";

describe("getCoreToolSpecs", () => {
  it("returns array of 2 tools", () => {
    const specs = getCoreToolSpecs();
    expect(specs).toHaveLength(2);
  });

  it("first tool is openreload_reload with correct schema", () => {
    const [reloadTool] = getCoreToolSpecs();

    expect(reloadTool.name).toBe("openreload_reload");
    expect(reloadTool.description).toBe(
      "Force brain reload. Works even if brain is in error state."
    );
    expect(reloadTool.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("second tool is openreload_status with correct schema", () => {
    const [, statusTool] = getCoreToolSpecs();

    expect(statusTool.name).toBe("openreload_status");
    expect(statusTool.description).toBe(
      "Report brain version, last reload time, last error, and loaded plugin count."
    );
    expect(statusTool.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("all tools have inputSchema with type object", () => {
    const specs = getCoreToolSpecs();

    for (const spec of specs) {
      expect(typeof spec.inputSchema).toBe("object");
      expect(spec.inputSchema).not.toBeNull();
      const inputSchema = spec.inputSchema as {
        type?: string;
      };
      expect(inputSchema.type).toBe("object");
    }
  });
});

describe("isCoreToolCall", () => {
  it("returns true for openreload_reload", () => {
    expect(isCoreToolCall("openreload_reload")).toBe(true);
  });

  it("returns true for openreload_status", () => {
    expect(isCoreToolCall("openreload_status")).toBe(true);
  });

  it("returns false for unknown tool name", () => {
    expect(isCoreToolCall("unknown_tool")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCoreToolCall("")).toBe(false);
  });
});

describe("handleStatusCall", () => {
  function makeStatus(overrides: Partial<ShellStatus> = {}): ShellStatus {
    return {
      brainLoaded: true,
      lastReloadAt: null,
      lastError: null,
      reloadCount: 0,
      pluginCount: 0,
      ...overrides,
    };
  }

  it("formats brain loaded status", () => {
    const result = handleStatusCall(makeStatus({ brainLoaded: true }));
    expect(result.content[0]?.text).toContain("Brain loaded: true");
  });

  it("shows 'never' when lastReloadAt is null", () => {
    const result = handleStatusCall(makeStatus({ lastReloadAt: null }));
    expect(result.content[0]?.text).toContain("Last reload: never");
  });

  it("shows ISO date when lastReloadAt is set", () => {
    const timestamp = Date.UTC(2025, 0, 1, 0, 0, 0);
    const result = handleStatusCall(makeStatus({ lastReloadAt: timestamp }));
    expect(result.content[0]?.text).toContain(
      `Last reload: ${new Date(timestamp).toISOString()}`
    );
  });

  it("includes reload count in output", () => {
    const result = handleStatusCall(makeStatus({ reloadCount: 7 }));
    expect(result.content[0]?.text).toContain("Reload count: 7");
  });

  it("shows error message or 'none'", () => {
    const withError = handleStatusCall(makeStatus({ lastError: "boom" }));
    expect(withError.content[0]?.text).toContain("Last error: boom");

    const withoutError = handleStatusCall(makeStatus({ lastError: null }));
    expect(withoutError.content[0]?.text).toContain("Last error: none");
  });

  it("returns proper ToolResult structure", () => {
    const result = handleStatusCall(makeStatus());

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.any(String),
    });
  });
});
