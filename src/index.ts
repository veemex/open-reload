export { loadConfig } from "./config/loader.ts";
export { loadPluginModule } from "./loader/module-loader.ts";
export { FileWatcher } from "./watcher/file-watcher.ts";
export { startServer } from "./server/mcp-server.ts";

export type {
  OpenReloadConfig,
  PluginConfig,
  PluginState,
  ManagedTool,
} from "./config/types.ts";
