import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { TrampolineRegistry } from "../src/native/trampolines.ts";
import { NativePluginManager } from "../src/native/manager.ts";
import { RuntimeBridge } from "../src/native/runtime-bridge.ts";
import { PluginEventBus } from "../src/brain/events/event-bus.ts";
import type { OpenReloadConfig } from "../src/brain/config/types.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

function makeTmpWithNodeModules(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "runtime-bridge-")));
  symlinkSync(join(PROJECT_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function writePlugin(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.ts");
  writeFileSync(file, content);
  return file;
}

function writeWorktreePlugin(worktreeRoot: string, content: string): string {
  return writePlugin(join(worktreeRoot, "template"), content);
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 1500,
  intervalMs = 20,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error("Timed out waiting for async bridge side effect");
}

const PLUGIN = `
export default async () => ({
  tool: {
    echo: {
      description: "Echo",
      args: {},
      execute: async (args) => String(args.text ?? ""),
    },
  },
});
`;

const TEMPLATE_PLUGIN = `
export default async () => ({
  tool: {
    selected: {
      description: "Selected template marker",
      args: {},
      execute: async () => "selected-template",
    },
  },
});
`;

describe("RuntimeBridge", () => {
  let tmpDir: string;
  let templateDir: string;
  let templateEntry: string;
  let registry: TrampolineRegistry;
  let eventBus: PluginEventBus;

  beforeEach(() => {
    tmpDir = makeTmpWithNodeModules();
    templateDir = join(tmpDir, "template");
    templateEntry = writePlugin(templateDir, PLUGIN);
    registry = new TrampolineRegistry();
    eventBus = new PluginEventBus();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(entry: string, watchDir: string, prefix = true): OpenReloadConfig {
    return {
      plugins: [
        {
          name: "base",
          entry,
          watchDir,
          exportType: "opencode-plugin",
          prefix,
        },
      ],
      debounceMs: 50,
      logLevel: "info",
    };
  }

  it("start() subscribes to events and stop() unsubscribes", async () => {
    const manager = new NativePluginManager(makeConfig(templateEntry, tmpDir), registry, eventBus, {});
    const bridge = new RuntimeBridge(manager, eventBus, makeConfig(templateEntry, tmpDir));

    const envA = "env_sub_1";
    const worktreeA = join(tmpDir, "worktree-a");
    writeWorktreePlugin(worktreeA, PLUGIN);

    bridge.start();
    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: { envId: envA, taskBranch: "feat/a", worktrees: { app: worktreeA } },
      timestamp: Date.now(),
    });

    await waitFor(() => manager.getState(`ocb@env_${envA}`)?.status === "loaded");
    expect(manager.getState(`ocb@env_${envA}`)?.status).toBe("loaded");

    bridge.stop();

    const envB = "env_sub_2";
    const worktreeB = join(tmpDir, "worktree-b");
    writeWorktreePlugin(worktreeB, PLUGIN);
    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: { envId: envB, taskBranch: "feat/b", worktrees: { app: worktreeB } },
      timestamp: Date.now(),
    });

    await Bun.sleep(60);
    expect(manager.getState(`ocb@env_${envB}`)).toBeUndefined();
  });

  it("loads plugin instances with single and multi-repo naming", async () => {
    const config = makeConfig(templateEntry, tmpDir);
    const manager = new NativePluginManager(config, registry, eventBus, {});
    const bridge = new RuntimeBridge(manager, eventBus, config);
    bridge.start();

    const singleEnv = "env_single";
    const singleWorktree = join(tmpDir, "single");
    writeWorktreePlugin(singleWorktree, PLUGIN);

    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: { envId: singleEnv, taskBranch: "feat/single", worktrees: { api: singleWorktree } },
      timestamp: Date.now(),
    });

    await waitFor(() => manager.getState(`ocb@env_${singleEnv}`)?.status === "loaded");
    expect(manager.getState(`ocb@env_${singleEnv}`)?.status).toBe("loaded");

    const multiEnv = "env_multi";
    const webTree = join(tmpDir, "multi-web");
    const apiTree = join(tmpDir, "multi-api");
    writeWorktreePlugin(webTree, PLUGIN);
    writeWorktreePlugin(apiTree, PLUGIN);

    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: {
        envId: multiEnv,
        taskBranch: "feat/multi",
        worktrees: { web: webTree, api: apiTree },
      },
      timestamp: Date.now(),
    });

    await waitFor(
      () =>
        manager.getState(`ocb@env_${multiEnv}/web`)?.status === "loaded" &&
        manager.getState(`ocb@env_${multiEnv}/api`)?.status === "loaded",
    );

    expect(manager.getState(`ocb@env_${multiEnv}/web`)).toBeDefined();
    expect(manager.getState(`ocb@env_${multiEnv}/api`)).toBeDefined();

    bridge.stop();
  });

  it("registers routes with routeKey envId and worktreePrefix", async () => {
    const config = makeConfig(templateEntry, tmpDir);
    const manager = new NativePluginManager(config, registry, eventBus, {});
    const bridge = new RuntimeBridge(manager, eventBus, config);
    bridge.start();

    const envId = "env_route";
    const worktree = join(tmpDir, "route-tree");
    writeWorktreePlugin(worktree, PLUGIN);

    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: { envId, taskBranch: "feat/route", worktrees: { repo: worktree } },
      timestamp: Date.now(),
    });

    await waitFor(() => registry.getRouteKeys("ocb@env_env_route_echo").includes(envId));

    const routed = registry.createToolTrampoline("ocb@env_env_route_echo");
    const result = await routed({ text: "routed" }, { worktree: join(worktree, "src") });
    expect(result).toBe("routed");

    bridge.stop();
  });

  it("handles cleanup: removes tracked plugins and ignores unknown envId", async () => {
    const config = makeConfig(templateEntry, tmpDir);
    const manager = new NativePluginManager(config, registry, eventBus, {});
    const bridge = new RuntimeBridge(manager, eventBus, config);
    bridge.start();

    const envId = "env_cleanup";
    const worktree = join(tmpDir, "cleanup-tree");
    writeWorktreePlugin(worktree, PLUGIN);

    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: { envId, taskBranch: "feat/cleanup", worktrees: { app: worktree } },
      timestamp: Date.now(),
    });

    await waitFor(() => manager.getState(`ocb@env_${envId}`)?.status === "loaded");

    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.cleanup_requested",
      payload: { envId: "env_unknown" },
      timestamp: Date.now(),
    });
    await Bun.sleep(30);
    expect(manager.getState(`ocb@env_${envId}`)).toBeDefined();

    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.cleanup_requested",
      payload: { envId },
      timestamp: Date.now(),
    });

    await waitFor(() => !manager.getState(`ocb@env_${envId}`));
    expect(registry.getRouteKeys(`ocb@env_${envId}_echo`)).toEqual([]);

    bridge.stop();
  });

  it("ignores invalid payloads for created/cleanup events", async () => {
    const config = makeConfig(templateEntry, tmpDir);
    const manager = new NativePluginManager(config, registry, eventBus, {});
    const bridge = new RuntimeBridge(manager, eventBus, config);
    bridge.start();

    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: null,
      timestamp: Date.now(),
    });
    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: { envId: "", worktrees: {} },
      timestamp: Date.now(),
    });
    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: { envId: "env_missing_worktrees", taskBranch: "x" },
      timestamp: Date.now(),
    });
    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.cleanup_requested",
      payload: null,
      timestamp: Date.now(),
    });
    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.cleanup_requested",
      payload: { nope: "x" },
      timestamp: Date.now(),
    });

    await Bun.sleep(40);
    expect(Object.keys(manager.getStatus())).toEqual([]);

    bridge.stop();
  });

  it("selects first opencode-plugin template from baseConfig", async () => {
    const selectedTemplateDir = join(tmpDir, "selected-template");
    const selectedTemplateEntry = writePlugin(selectedTemplateDir, TEMPLATE_PLUGIN);
    const config: OpenReloadConfig = {
      plugins: [
        {
          name: "skip",
          entry: join(tmpDir, "skip.ts"),
          exportType: "tool-array",
        },
        {
          name: "template",
          entry: selectedTemplateEntry,
          watchDir: tmpDir,
          exportType: "opencode-plugin",
          prefix: true,
        },
      ],
      debounceMs: 50,
    };
    const manager = new NativePluginManager(config, registry, eventBus, {});
    const bridge = new RuntimeBridge(manager, eventBus, config);
    bridge.start();

    const envId = "env_template";
    const worktree = join(tmpDir, "template-tree");
    writePlugin(join(worktree, "selected-template"), TEMPLATE_PLUGIN);

    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: { envId, taskBranch: "feat/template", worktrees: { app: worktree } },
      timestamp: Date.now(),
    });

    await waitFor(() => registry.getRouteKeys("ocb@env_env_template_selected").includes(envId));
    const invoke = registry.createToolTrampoline("ocb@env_env_template_selected");
    expect(await invoke({}, { worktree })).toBe("selected-template");

    bridge.stop();
  });

  it("ignores created events when no opencode-plugin template exists", async () => {
    const config: OpenReloadConfig = {
      plugins: [
        {
          name: "unsupported",
          entry: join(tmpDir, "unsupported.ts"),
          exportType: "tool-array",
        },
      ],
      debounceMs: 50,
    };
    const manager = new NativePluginManager(config, registry, eventBus, {});
    const bridge = new RuntimeBridge(manager, eventBus, config);
    bridge.start();

    const envId = "env_no_template";
    const worktree = join(tmpDir, "no-template-tree");
    writePlugin(worktree, PLUGIN);
    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: { envId, taskBranch: "feat/none", worktrees: { app: worktree } },
      timestamp: Date.now(),
    });

    await Bun.sleep(40);
    expect(Object.keys(manager.getStatus())).toEqual([]);

    bridge.stop();
  });

  it("handles duplicate envId create events without duplicating plugin instances", async () => {
    const config = makeConfig(templateEntry, tmpDir);
    const manager = new NativePluginManager(config, registry, eventBus, {});
    const bridge = new RuntimeBridge(manager, eventBus, config);
    bridge.start();

    const envId = "env_dup";
    const worktree = join(tmpDir, "dup-tree");
    writeWorktreePlugin(worktree, PLUGIN);

    const createdEvent = {
      source: "ocb",
      type: "ocb.environment.created",
      payload: { envId, taskBranch: "feat/dup", worktrees: { app: worktree } },
      timestamp: Date.now(),
    } as const;

    await eventBus.emit(createdEvent);
    await waitFor(() => manager.getState(`ocb@env_${envId}`)?.status === "loaded");

    await eventBus.emit({ ...createdEvent, timestamp: Date.now() + 1 });
    await waitFor(() => manager.getState(`ocb@env_${envId}`)?.status === "loaded");

    const state = manager.getState(`ocb@env_${envId}`);
    expect(state?.status).toBe("loaded");
    expect(Object.keys(manager.getStatus()).filter((name) => name === `ocb@env_${envId}`)).toHaveLength(1);

    bridge.stop();
  });

  it("continues loading siblings when addPlugin fails for one worktree", async () => {
    const config = makeConfig(templateEntry, tmpDir);
    const manager = new NativePluginManager(config, registry, eventBus, {});
    const originalAddPlugin = manager.addPlugin.bind(manager);
    manager.addPlugin = async (pluginConfig, routeSpec) => {
      if (pluginConfig.name.endsWith("/bad")) {
        throw new Error("forced addPlugin failure for bad repo");
      }
      return originalAddPlugin(pluginConfig, routeSpec);
    };
    const bridge = new RuntimeBridge(manager, eventBus, config);
    bridge.start();

    const envId = "env_partial";
    const goodWorktree = join(tmpDir, "good-worktree");
    writeWorktreePlugin(goodWorktree, PLUGIN);
    const badWorktree = join(tmpDir, "bad-worktree");
    mkdirSync(badWorktree, { recursive: true });

    await eventBus.emit({
      source: "ocb",
      type: "ocb.environment.created",
      payload: {
        envId,
        taskBranch: "feat/partial",
        worktrees: {
          good: goodWorktree,
          bad: badWorktree,
        },
      },
      timestamp: Date.now(),
    });

    await waitFor(() => manager.getState(`ocb@env_${envId}/good`)?.status === "loaded");
    expect(manager.getState(`ocb@env_${envId}/good`)?.status).toBe("loaded");
    expect(manager.getState(`ocb@env_${envId}/bad`)).toBeUndefined();

    bridge.stop();
  });
});
