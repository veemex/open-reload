export type ToolExecuteFn = (
  args: Record<string, unknown>,
  context: unknown,
) => Promise<string>;

export type RouteKey = string;

export type RouteSpec = {
  routeKey: RouteKey;
  worktreePrefix?: string;
  priority?: number;
};

export type HookFn = (...args: unknown[]) => Promise<void>;

export type HookEntry = {
  pluginName: string;
  fn: HookFn;
};

export class TrampolineRegistry {
  private toolBackings = new Map<string, ToolExecuteFn>();
  private routeTable = new Map<
    string,
    Map<RouteKey, { execute: ToolExecuteFn; spec: RouteSpec }>
  >();
  private hookEntries = new Map<string, HookEntry[]>();

  setToolBacking(qualifiedName: string, execute: ToolExecuteFn): void {
    this.toolBackings.set(qualifiedName, execute);
  }

  removeToolBacking(qualifiedName: string): void {
    this.toolBackings.delete(qualifiedName);
  }

  hasToolBacking(qualifiedName: string): boolean {
    return this.toolBackings.has(qualifiedName);
  }

  registerRoute(
    toolName: string,
    routeKey: RouteKey,
    execute: ToolExecuteFn,
    spec?: RouteSpec,
  ): void {
    const routes = this.routeTable.get(toolName) ?? new Map();
    routes.set(routeKey, {
      execute,
      spec: {
        routeKey,
        worktreePrefix: spec?.worktreePrefix,
        priority: spec?.priority,
      },
    });
    this.routeTable.set(toolName, routes);
  }

  unregisterRoute(toolName: string, routeKey: RouteKey): void {
    const routes = this.routeTable.get(toolName);
    if (!routes) {
      return;
    }
    routes.delete(routeKey);
    if (routes.size === 0) {
      this.routeTable.delete(toolName);
    }
  }

  resolveRoute(toolName: string, context: unknown): ToolExecuteFn | undefined {
    const routes = this.routeTable.get(toolName);
    if (!routes || routes.size === 0) {
      return undefined;
    }

    const contextPath = this.getContextPath(context);
    if (!contextPath) {
      return undefined;
    }

    let selected:
      | { execute: ToolExecuteFn; spec: RouteSpec; prefixLength: number }
      | undefined;
    for (const route of routes.values()) {
      const prefix = route.spec.worktreePrefix;
      if (!prefix || !contextPath.startsWith(prefix)) {
        continue;
      }

      const prefixLength = prefix.length;
      if (!selected || prefixLength > selected.prefixLength) {
        selected = { ...route, prefixLength };
        continue;
      }

      if (
        prefixLength === selected.prefixLength &&
        (route.spec.priority ?? 0) > (selected.spec.priority ?? 0)
      ) {
        selected = { ...route, prefixLength };
      }
    }

    return selected?.execute;
  }

  getRouteKeys(toolName: string): RouteKey[] {
    const routes = this.routeTable.get(toolName);
    if (!routes) {
      return [];
    }
    return [...routes.keys()];
  }

  createToolTrampoline(qualifiedName: string): ToolExecuteFn {
    return async (
      args: Record<string, unknown>,
      context: unknown,
    ): Promise<string> => {
      const backing =
        this.resolveRoute(qualifiedName, context) ??
        this.toolBackings.get(qualifiedName);
      if (!backing) {
        throw new Error(
          `Tool "${qualifiedName}" not loaded (plugin may have been unloaded)`,
        );
      }
      return backing(args, context);
    };
  }

  addHookEntry(hookType: string, pluginName: string, fn: HookFn): void {
    const entries = this.hookEntries.get(hookType) ?? [];
    entries.push({ pluginName, fn });
    this.hookEntries.set(hookType, entries);
  }

  removePluginHooks(pluginName: string): void {
    for (const [hookType, entries] of this.hookEntries) {
      const filtered = entries.filter((e) => e.pluginName !== pluginName);
      if (filtered.length > 0) {
        this.hookEntries.set(hookType, filtered);
      } else {
        this.hookEntries.delete(hookType);
      }
    }
  }

  getHookEntries(hookType: string): HookEntry[] {
    return this.hookEntries.get(hookType) ?? [];
  }

  createHookTrampoline(hookType: string): HookFn {
    return async (...args: unknown[]): Promise<void> => {
      const entries = this.hookEntries.get(hookType) ?? [];
      for (const entry of entries) {
        try {
          await entry.fn(...args);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[open-reload] Hook "${hookType}" from "${entry.pluginName}" error: ${msg}\n`,
          );
        }
      }
    };
  }

  clearRoutes(): void {
    this.routeTable.clear();
  }

  clear(): void {
    this.toolBackings.clear();
    this.routeTable.clear();
    this.hookEntries.clear();
  }

  private getContextPath(context: unknown): string | undefined {
    if (!context || typeof context !== "object") {
      return undefined;
    }

    const contextObj = context as { worktree?: unknown; directory?: unknown };
    if (typeof contextObj.worktree === "string") {
      return contextObj.worktree;
    }
    if (typeof contextObj.directory === "string") {
      return contextObj.directory;
    }
    return undefined;
  }
}
