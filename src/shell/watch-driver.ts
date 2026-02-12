import { watch, type FSWatcher } from "fs";
import { resolve } from "path";

export type WatchCallback = (changedPath: string) => void;

interface WatcherOptions {
  watchDir: string;
  debounceMs: number;
  onChange: WatchCallback;
  ignorePatterns?: string[];
}

const DEFAULT_IGNORE = ["node_modules", ".git", "dist", ".test.", ".spec."];
const WATCHED_EXTENSIONS = /\.(ts|js|mts|mjs)$/;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private options: Required<WatcherOptions>;

  constructor(options: WatcherOptions) {
    this.options = {
      ...options,
      ignorePatterns: options.ignorePatterns ?? DEFAULT_IGNORE,
    };
  }

  start(): void {
    if (this.watcher) return;

    this.watcher = watch(
      this.options.watchDir,
      { recursive: true },
      (_event: string, filename: string | null) => {
        if (!filename) return;
        if (this.shouldIgnore(filename)) return;
        if (!WATCHED_EXTENSIONS.test(filename)) return;

        const fullPath = resolve(this.options.watchDir, filename);
        this.debounce(fullPath);
      }
    );
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private debounce(changedPath: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.options.onChange(changedPath);
    }, this.options.debounceMs);
  }

  private shouldIgnore(filename: string): boolean {
    return this.options.ignorePatterns.some((pattern) =>
      filename.includes(pattern)
    );
  }
}
