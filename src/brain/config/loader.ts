import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import type { OpenReloadConfig, PluginConfig } from "./types.ts";

const CONFIG_FILENAME = "open-reload.json";

/**
 * Config resolution order:
 * 1. Explicit path argument
 * 2. Local: .opencode/open-reload.json
 * 3. Global: ~/.config/open-reload/open-reload.json
 */
export async function loadConfig(
  explicitPath?: string
): Promise<OpenReloadConfig> {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        resolve(process.cwd(), ".opencode", CONFIG_FILENAME),
        resolve(
          process.env.HOME || "~",
          ".config",
          "open-reload",
          CONFIG_FILENAME
        ),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const raw = await readFile(candidate, "utf-8");
      const parsed = JSON.parse(raw);
      return validateConfig(parsed, candidate);
    }
  }

  throw new Error(
    `No ${CONFIG_FILENAME} found. Searched:\n${candidates.map((c) => `  - ${c}`).join("\n")}`
  );
}

function validateConfig(
  raw: unknown,
  filePath: string
): OpenReloadConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid config at ${filePath}: must be an object`);
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.plugins) || obj.plugins.length === 0) {
    throw new Error(
      `Invalid config at ${filePath}: "plugins" must be a non-empty array`
    );
  }

  const plugins: PluginConfig[] = obj.plugins.map(
    (p: unknown, i: number) => {
      if (!p || typeof p !== "object") {
        throw new Error(`Invalid plugin at index ${i}: must be an object`);
      }
      const plugin = p as Record<string, unknown>;

      if (typeof plugin.name !== "string" || !plugin.name.trim()) {
        throw new Error(`Plugin at index ${i}: "name" is required`);
      }

      if (typeof plugin.entry !== "string" || !plugin.entry.trim()) {
        throw new Error(`Plugin "${plugin.name}": "entry" is required`);
      }

      const entry = resolve(plugin.entry as string);
      if (!existsSync(entry)) {
        throw new Error(
          `Plugin "${plugin.name}": entry file does not exist: ${entry}`
        );
      }

      const validExportTypes = [
        "opencode-plugin",
        "tool-array",
        "mcp-tools",
      ];
      const exportType = (plugin.exportType as string) || "opencode-plugin";
      if (!validExportTypes.includes(exportType)) {
        throw new Error(
          `Plugin "${plugin.name}": exportType must be one of: ${validExportTypes.join(", ")}`
        );
      }

      const watchDir = plugin.watchDir
        ? resolve(plugin.watchDir as string)
        : dirname(entry);

      if (!existsSync(watchDir)) {
        throw new Error(
          `Plugin "${plugin.name}": watchDir does not exist: ${watchDir}`
        );
      }

      const prefix =
        typeof plugin.prefix === "boolean" ? plugin.prefix : true;

      let worktreePath: string | undefined;
      if (plugin.worktreePath != null) {
        if (typeof plugin.worktreePath !== "string" || !plugin.worktreePath.trim()) {
          throw new Error(
            `Plugin "${plugin.name}": "worktreePath" must be a non-empty string`
          );
        }
        worktreePath = resolve(plugin.worktreePath as string);
        if (!existsSync(worktreePath)) {
          throw new Error(
            `Plugin "${plugin.name}": worktreePath does not exist: ${worktreePath}`
          );
        }
      }

      return {
        name: plugin.name as string,
        entry,
        watchDir,
        exportType: exportType as PluginConfig["exportType"],
        prefix,
        worktreePath,
      };
    }
  );

  const debounceMs =
    typeof obj.debounceMs === "number" ? obj.debounceMs : 300;
  const logLevel =
    typeof obj.logLevel === "string" &&
    ["error", "warn", "info", "debug"].includes(obj.logLevel)
      ? (obj.logLevel as OpenReloadConfig["logLevel"])
      : "info";
  const logFile =
    typeof obj.logFile === "string" ? obj.logFile : undefined;

  return { plugins, debounceMs, logLevel, logFile };
}
