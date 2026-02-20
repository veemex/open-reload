import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildPluginInput,
  resetCache,
  getRuntimeInfo,
} from "../src/brain/context/opencode-runtime.ts";

describe("buildPluginInput", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetCache();
  });

  describe("without OPENCODE_PORT", () => {
    it("returns minimal input with directory and worktree", async () => {
      delete process.env.OPENCODE_PORT;
      const input = await buildPluginInput("/test/dir");
      expect(input.directory).toBe("/test/dir");
      expect(input.worktree).toBe("/test/dir");
    });

    it("does not set client or serverUrl", async () => {
      delete process.env.OPENCODE_PORT;
      const input = await buildPluginInput("/test/dir");
      expect(input.client).toBeUndefined();
      expect(input.serverUrl).toBeUndefined();
    });

    it("reports runtime not detected", async () => {
      delete process.env.OPENCODE_PORT;
      await buildPluginInput("/test/dir");
      const info = getRuntimeInfo();
      expect(info.detected).toBe(false);
      expect(info.hasClient).toBe(false);
      expect(info.hasAuth).toBe(false);
    });

    it("provides Bun shell when available", async () => {
      delete process.env.OPENCODE_PORT;
      const input = await buildPluginInput("/test/dir");
      if (typeof Bun !== "undefined") {
        expect(input.$).toBeDefined();
      }
    });
  });

  describe("with OPENCODE_PORT", () => {
    it("detects OpenCode runtime", async () => {
      process.env.OPENCODE_PORT = "9999";
      await buildPluginInput("/test/dir");
      const info = getRuntimeInfo();
      expect(info.detected).toBe(true);
      expect(info.serverUrl).toBe("http://localhost:9999");
    });

    it("creates serverUrl from port", async () => {
      process.env.OPENCODE_PORT = "5555";
      const input = await buildPluginInput("/test/dir");
      expect(input.serverUrl).toBeInstanceOf(URL);
      expect(input.serverUrl?.toString()).toBe("http://localhost:5555/");
    });

    it("creates real client via SDK", async () => {
      process.env.OPENCODE_PORT = "4096";
      const input = await buildPluginInput("/test/dir");
      expect(input.client).toBeDefined();
      const info = getRuntimeInfo();
      expect(info.hasClient).toBe(true);
    });

    it("client has expected API surface", async () => {
      process.env.OPENCODE_PORT = "4096";
      const input = await buildPluginInput("/test/dir");
      const client = input.client as Record<string, unknown>;
      expect(client.session).toBeDefined();
      expect(client.project).toBeDefined();
      expect(client.config).toBeDefined();
      expect(client.file).toBeDefined();
      expect(client.tool).toBeDefined();
      expect(client.tui).toBeDefined();
      expect(client.event).toBeDefined();
    });

    it("sets auth header when OPENCODE_SERVER_PASSWORD present", async () => {
      process.env.OPENCODE_PORT = "4096";
      process.env.OPENCODE_SERVER_PASSWORD = "test-pass";
      await buildPluginInput("/test/dir");
      const info = getRuntimeInfo();
      expect(info.hasAuth).toBe(true);
    });

    it("works without OPENCODE_SERVER_PASSWORD", async () => {
      process.env.OPENCODE_PORT = "4096";
      delete process.env.OPENCODE_SERVER_PASSWORD;
      const input = await buildPluginInput("/test/dir");
      expect(input.client).toBeDefined();
      const info = getRuntimeInfo();
      expect(info.hasAuth).toBe(false);
      expect(info.hasClient).toBe(true);
    });

    it("project fetch fails gracefully (no server running)", async () => {
      process.env.OPENCODE_PORT = "19999";
      const input = await buildPluginInput("/test/dir");
      expect(input.client).toBeDefined();
      expect(input.project).toBeUndefined();
      const info = getRuntimeInfo();
      expect(info.hasProject).toBe(false);
    });
  });

  describe("caching", () => {
    it("returns cached result for same cwd", async () => {
      delete process.env.OPENCODE_PORT;
      const first = await buildPluginInput("/test/dir");
      const second = await buildPluginInput("/test/dir");
      expect(first).toBe(second);
    });

    it("rebuilds for different cwd", async () => {
      delete process.env.OPENCODE_PORT;
      const first = await buildPluginInput("/test/dir1");
      const second = await buildPluginInput("/test/dir2");
      expect(first.directory).toBe("/test/dir1");
      expect(second.directory).toBe("/test/dir2");
    });

    it("resetCache forces rebuild", async () => {
      delete process.env.OPENCODE_PORT;
      const first = await buildPluginInput("/test/dir");
      resetCache();
      const second = await buildPluginInput("/test/dir");
      expect(first).not.toBe(second);
      expect(first.directory).toBe(second.directory);
    });
  });
});
