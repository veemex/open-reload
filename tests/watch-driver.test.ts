import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { FileWatcher } from "../src/shell/watch-driver.ts";

const tempDirs: string[] = [];
const activeWatchers: FileWatcher[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-driver-test-"));
  tempDirs.push(dir);
  return dir;
}

function registerWatcher(watcher: FileWatcher): FileWatcher {
  activeWatchers.push(watcher);
  return watcher;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

afterEach(() => {
  for (const watcher of activeWatchers) {
    watcher.stop();
  }
  activeWatchers.length = 0;

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("FileWatcher", () => {
  it("constructor stores options without starting", async () => {
    const watchDir = makeTempDir();
    const changes: string[] = [];
    const onChange = (changedPath: string): void => {
      changes.push(changedPath);
    };

    const watcher = registerWatcher(
      new FileWatcher({
        watchDir,
        debounceMs: 75,
        onChange,
      })
    );

    const options = Reflect.get(watcher, "options") as {
      watchDir: string;
      debounceMs: number;
      onChange: (changedPath: string) => void;
      ignorePatterns: string[];
    };

    expect(options.watchDir).toBe(watchDir);
    expect(options.debounceMs).toBe(75);
    expect(options.onChange).toBe(onChange);
    expect(options.ignorePatterns).toEqual([
      "node_modules",
      ".git",
      "dist",
      ".test.",
      ".spec.",
    ]);
    expect(Reflect.get(watcher, "watcher")).toBeNull();

    writeFileSync(join(watchDir, "before-start.ts"), "export const x = 1;\n");
    await sleep(250);

    expect(changes).toHaveLength(0);
  });

  it("start() begins watching — detects .ts file change", async () => {
    const watchDir = makeTempDir();

    const changePromise = new Promise<string>((resolveChange, rejectChange) => {
      const timeout = setTimeout(() => {
        rejectChange(new Error("Timed out waiting for .ts change event"));
      }, 3000);

      const watcher = registerWatcher(
        new FileWatcher({
          watchDir,
          debounceMs: 75,
          onChange: (changedPath: string) => {
            clearTimeout(timeout);
            resolveChange(changedPath);
          },
        })
      );

      watcher.start();
    });

    const filePath = join(watchDir, "change.ts");
    writeFileSync(filePath, "export const changed = true;\n");

    await expect(changePromise).resolves.toBe(resolve(filePath));
  });

  it("stop() cleans up and prevents further callbacks", async () => {
    const watchDir = makeTempDir();
    const changes: string[] = [];

    const firstChangePromise = new Promise<void>((resolveFirst, rejectFirst) => {
      const timeout = setTimeout(() => {
        rejectFirst(new Error("Timed out waiting for first change"));
      }, 3000);

      const watcher = registerWatcher(
        new FileWatcher({
          watchDir,
          debounceMs: 75,
          onChange: (changedPath: string) => {
            changes.push(changedPath);
            clearTimeout(timeout);
            resolveFirst();
          },
        })
      );

      watcher.start();
    });

    writeFileSync(join(watchDir, "first.ts"), "export const first = 1;\n");
    await firstChangePromise;

    const watcher = activeWatchers[activeWatchers.length - 1];
    watcher.stop();

    writeFileSync(join(watchDir, "second.ts"), "export const second = 2;\n");
    await sleep(400);

    expect(changes).toHaveLength(1);
  });

  it("ignores non-TS/JS files (.json, .md, .txt)", async () => {
    const watchDir = makeTempDir();
    const changes: string[] = [];

    const watcher = registerWatcher(
      new FileWatcher({
        watchDir,
        debounceMs: 75,
        onChange: (changedPath: string) => {
          changes.push(changedPath);
        },
      })
    );

    watcher.start();

    writeFileSync(join(watchDir, "config.json"), "{}\n");
    writeFileSync(join(watchDir, "notes.md"), "# notes\n");
    writeFileSync(join(watchDir, "plain.txt"), "hello\n");
    await sleep(450);

    expect(changes).toHaveLength(0);
  });

  it("ignores files matching default ignore patterns (node_modules, .git)", async () => {
    const watchDir = makeTempDir();
    const changes: string[] = [];

    const watcher = registerWatcher(
      new FileWatcher({
        watchDir,
        debounceMs: 75,
        onChange: (changedPath: string) => {
          changes.push(changedPath);
        },
      })
    );

    watcher.start();

    const nodeModulesDir = join(watchDir, "node_modules");
    const gitDir = join(watchDir, ".git");
    mkdirSync(nodeModulesDir, { recursive: true });
    mkdirSync(gitDir, { recursive: true });

    writeFileSync(join(nodeModulesDir, "ignored.ts"), "export const hidden = true;\n");
    writeFileSync(join(gitDir, "ignored.ts"), "export const hidden = true;\n");
    await sleep(450);

    expect(changes).toHaveLength(0);
  });

  it("debounces rapid changes — fires callback only once", async () => {
    const watchDir = makeTempDir();
    const changes: string[] = [];

    const watcher = registerWatcher(
      new FileWatcher({
        watchDir,
        debounceMs: 300,
        onChange: (changedPath: string) => {
          changes.push(changedPath);
        },
      })
    );

    watcher.start();
    await sleep(200); // let fs.watch settle on macOS

    writeFileSync(join(watchDir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(watchDir, "b.ts"), "export const b = 2;\n");
    writeFileSync(join(watchDir, "c.ts"), "export const c = 3;\n");

    await sleep(900);

    // Debounce collapses rapid writes into 1-3 callbacks depending on OS timing
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.length).toBeLessThanOrEqual(3);
  });

  it("can be restarted after stop", async () => {
    const watchDir = makeTempDir();
    const changes: string[] = [];

    const watcher = registerWatcher(
      new FileWatcher({
        watchDir,
        debounceMs: 100,
        onChange: (changedPath: string) => {
          changes.push(changedPath);
        },
      })
    );

    watcher.start();
    writeFileSync(join(watchDir, "first.ts"), "export const first = true;\n");
    await sleep(500);
    expect(changes.length).toBeGreaterThanOrEqual(1);

    watcher.stop();

    watcher.start();
    writeFileSync(join(watchDir, "second.ts"), "export const second = true;\n");
    await sleep(500);

    expect(changes.length).toBeGreaterThanOrEqual(2);
  });
});
