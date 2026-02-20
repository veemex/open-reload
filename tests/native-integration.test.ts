import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

function writePlugin(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.ts");
  writeFileSync(file, content);
  return file;
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 1500,
  intervalMs = 20,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error("Timed out waiting for integration condition");
}

const MOCK_PLUGIN = `
import { z } from "zod";
export default async () => ({
  tool: {
    echo: {
      description: "Echoes input",
      args: { text: z.string() },
      execute: async (args) => args.text,
    },
  },
});
`;

const MOCK_PLUGIN_WITH_HOOKS = `
import { z } from "zod";
export default async () => ({
  tool: {
    greet: {
      description: "Greets",
      args: { name: z.string() },
      execute: async (args) => "Hello " + args.name,
    },
  },
  event: async (input) => {},
  "chat.params": async (input, output) => {
    output.temperature = 0.42;
  },
});
`;

const BRIDGE_BASE_PLUGIN = `
export default async () => ({
  tool: {
    whoami: {
      description: "Identifies plugin source",
      args: {},
      execute: async (_args, context) => {
        const worktree = context?.worktree;
        if (typeof worktree === "string" && worktree.includes("worktree-plugin")) {
          return "worktree";
        }
        return "base";
      },
    },
    emit_created: {
      description: "Emit runtime bridge create event",
      args: {},
      execute: async (args, context) => {
        await context.events.emit("ocb.environment.created", {
          envId: String(args.envId),
          taskBranch: "feat/runtime-bridge",
          worktrees: { app: String(args.worktree) },
        });
        return "created";
      },
    },
    emit_cleanup: {
      description: "Emit runtime bridge cleanup event",
      args: {},
      execute: async (args, context) => {
        await context.events.emit("ocb.environment.cleanup_requested", {
          envId: String(args.envId),
        });
        return "cleanup";
      },
    },
  },
});
`;

const BRIDGE_WORKTREE_PLUGIN = `
export default async () => ({
  tool: {
    whoami: {
      description: "Identifies plugin source",
      args: {},
      execute: async () => "worktree",
    },
  },
});
`;

describe("native plugin entry point", () => {
  let tmpDir: string;
  let pluginDir: string;
  let configDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "native-e2e-"));
    pluginDir = join(tmpDir, "plugin");
    configDir = join(tmpDir, ".opencode");
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(pluginDir, "node_modules"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(
    plugins: Array<{ name: string; entry: string; watchDir: string; prefix?: boolean }>,
  ) {
    const config = {
      plugins: plugins.map((p) => ({
        ...p,
        exportType: "opencode-plugin",
      })),
      debounceMs: 50,
    };
    writeFileSync(join(configDir, "open-reload.json"), JSON.stringify(config));
  }

  it("loads plugin and returns tools + hooks + dispose", async () => {
    const entry = writePlugin(pluginDir, MOCK_PLUGIN);
    writeConfig([{ name: "mock", entry, watchDir: pluginDir }]);

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });

    expect(result.tool).toBeDefined();
    const toolMap = result.tool as Record<string, Record<string, unknown>>;

    expect(toolMap.openreload_reload).toBeDefined();
    expect(toolMap.openreload_status).toBeDefined();
    expect(toolMap.mock_echo).toBeDefined();
    expect(toolMap.mock_echo.description).toBe("Echoes input");

    expect(typeof result.dispose).toBe("function");

    const dispose = result.dispose as () => Promise<void>;
    await dispose();
  });

  it("trampoline tools delegate to loaded implementations", async () => {
    const entry = writePlugin(pluginDir, MOCK_PLUGIN);
    writeConfig([{ name: "mock", entry, watchDir: pluginDir }]);

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });

    const toolMap = result.tool as Record<
      string,
      { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }
    >;
    const echoResult = await toolMap.mock_echo.execute({ text: "hello" }, undefined);
    expect(echoResult).toBe("hello");

    const dispose = result.dispose as () => Promise<void>;
    await dispose();
  });

  it("includes hook trampolines in return", async () => {
    const entry = writePlugin(pluginDir, MOCK_PLUGIN_WITH_HOOKS);
    writeConfig([{ name: "hooked", entry, watchDir: pluginDir }]);

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });

    expect(typeof result.event).toBe("function");
    expect(typeof result["chat.params"]).toBe("function");
    expect(typeof result["tool.execute.before"]).toBe("function");

    const chatParams = result["chat.params"] as (...args: unknown[]) => Promise<void>;
    const output = { temperature: 0.7, topP: 1.0 };
    await chatParams({}, output);
    expect(output.temperature).toBe(0.42);

    const dispose = result.dispose as () => Promise<void>;
    await dispose();
  });

  it("management tools work", async () => {
    const entry = writePlugin(pluginDir, MOCK_PLUGIN);
    writeConfig([{ name: "mock", entry, watchDir: pluginDir }]);

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });

    const toolMap = result.tool as Record<
      string,
      { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }
    >;

    const statusResult = await toolMap.openreload_status.execute({}, undefined);
    expect(statusResult).toContain("mock");
    expect(statusResult).toContain("loaded");
    expect(statusResult).toContain("mock_echo");

    const dispose = result.dispose as () => Promise<void>;
    await dispose();
  });

  it("openreload_invoke dispatches tool calls with parsed JSON args", async () => {
    const entry = writePlugin(pluginDir, MOCK_PLUGIN);
    writeConfig([{ name: "mock", entry, watchDir: pluginDir }]);

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });
    const toolMap = result.tool as Record<
      string,
      { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }
    >;

    const invokeResult = await toolMap.openreload_invoke.execute(
      { tool: "mock_echo", args: '{"text":"via invoke"}' },
      undefined,
    );
    expect(invokeResult).toBe("via invoke");

    await (result.dispose as () => Promise<void>)();
  });

  it("openreload_invoke returns a clear error for invalid JSON args", async () => {
    const entry = writePlugin(pluginDir, MOCK_PLUGIN);
    writeConfig([{ name: "mock", entry, watchDir: pluginDir }]);

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });
    const toolMap = result.tool as Record<
      string,
      { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }
    >;

    await expect(
      toolMap.openreload_invoke.execute(
        { tool: "mock_echo", args: '{"text": "broken"' },
        undefined,
      ),
    ).rejects.toThrow("Invalid JSON for args");

    await (result.dispose as () => Promise<void>)();
  });

  it("openreload_invoke returns a clear error for unknown tool", async () => {
    const entry = writePlugin(pluginDir, MOCK_PLUGIN);
    writeConfig([{ name: "mock", entry, watchDir: pluginDir }]);

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });
    const toolMap = result.tool as Record<
      string,
      { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }
    >;

    await expect(
      toolMap.openreload_invoke.execute(
        { tool: "missing_tool", args: "{}" },
        undefined,
      ),
    ).rejects.toThrow('Failed to invoke tool "missing_tool"');

    await (result.dispose as () => Promise<void>)();
  });

  it("runtime bridge activates and status reflects environment-created plugin", async () => {
    const entry = writePlugin(pluginDir, BRIDGE_BASE_PLUGIN);
    writeConfig([{ name: "bridge", entry, watchDir: tmpDir, prefix: false }]);

    const worktreeRoot = join(tmpDir, "worktree-plugin");
    mkdirSync(worktreeRoot, { recursive: true });
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(worktreeRoot, "node_modules"));
    writePlugin(join(worktreeRoot, "plugin"), BRIDGE_WORKTREE_PLUGIN);

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });
    const toolMap = result.tool as Record<
      string,
      { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }
    >;

    await toolMap.emit_created.execute({ envId: "env_status", worktree: worktreeRoot }, {});

    await waitFor(async () => {
      const status = await toolMap.openreload_status.execute({}, undefined);
      return status.includes("ocb@env_env_status");
    });

    await (result.dispose as () => Promise<void>)();
  });

  it("end-to-end: created event loads worktree route, openreload_invoke routes and cleanup removes plugin", async () => {
    const entry = writePlugin(pluginDir, BRIDGE_BASE_PLUGIN);
    writeConfig([{ name: "bridge", entry, watchDir: tmpDir, prefix: false }]);

    const worktreeRoot = join(tmpDir, "worktree-plugin-e2e");
    mkdirSync(worktreeRoot, { recursive: true });
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(worktreeRoot, "node_modules"));
    writePlugin(join(worktreeRoot, "plugin"), BRIDGE_WORKTREE_PLUGIN);

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });
    const toolMap = result.tool as Record<
      string,
      { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }
    >;

    const envId = "env_e2e";
    await toolMap.emit_created.execute({ envId, worktree: worktreeRoot }, {});

    await waitFor(async () => {
      const routedResult = await toolMap.openreload_invoke.execute(
        { tool: "whoami", routeKey: envId },
        undefined,
      );
      return routedResult === "worktree";
    });

    const routed = await toolMap.openreload_invoke.execute({ tool: "whoami", routeKey: envId }, undefined);
    expect(routed).toBe("worktree");

    const fallback = await toolMap.openreload_invoke.execute(
      { tool: "whoami" },
      { directory: tmpDir },
    );
    expect(fallback).toBe("base");

    await toolMap.emit_cleanup.execute({ envId }, {});
    await waitFor(async () => {
      const status = await toolMap.openreload_status.execute({}, undefined);
      return !status.includes("ocb@env_env_e2e");
    });

    await (result.dispose as () => Promise<void>)();
  });

  it("openreload_invoke rejects explicit unknown routeKey", async () => {
    const entry = writePlugin(pluginDir, BRIDGE_BASE_PLUGIN);
    writeConfig([{ name: "bridge", entry, watchDir: tmpDir, prefix: false }]);

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });
    const toolMap = result.tool as Record<
      string,
      { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }
    >;

    const worktreeRoot = join(tmpDir, "worktree-plugin-routes");
    mkdirSync(worktreeRoot, { recursive: true });
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(worktreeRoot, "node_modules"));
    writePlugin(join(worktreeRoot, "plugin"), BRIDGE_WORKTREE_PLUGIN);

    await toolMap.emit_created.execute({ envId: "env_known", worktree: worktreeRoot }, {});
    await waitFor(async () => {
      const routedResult = await toolMap.openreload_invoke.execute(
        { tool: "whoami", routeKey: "env_known" },
        undefined,
      );
      return routedResult === "worktree";
    });

    await expect(
      toolMap.openreload_invoke.execute(
        { tool: "whoami", routeKey: "env_missing" },
        undefined,
      ),
    ).rejects.toThrow('has no route "env_missing"');

    await toolMap.emit_cleanup.execute({ envId: "env_known" }, {});
    await waitFor(async () => {
      const status = await toolMap.openreload_status.execute({}, undefined);
      return !status.includes("ocb@env_env_known");
    });

    await (result.dispose as () => Promise<void>)();
  });

  it("handles missing config gracefully", async () => {
    rmSync(configDir, { recursive: true, force: true });

    const openReloadNative = (await import("../src/native/index.ts")).default;
    const result = await openReloadNative({ directory: tmpDir, worktree: tmpDir });

    const toolMap = result.tool as Record<string, unknown>;
    expect(toolMap.openreload_reload).toBeDefined();
    expect(toolMap.openreload_status).toBeDefined();

    const dispose = result.dispose as () => Promise<void>;
    await dispose();
  });
});
