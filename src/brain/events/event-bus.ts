export type PluginEvent = {
  source: string;
  type: string;
  payload: unknown;
  timestamp: number;
};

export type EventHandler = (event: PluginEvent) => void | Promise<void>;

type PluginRegistration = {
  type: string;
  handler: EventHandler;
};

export class PluginEventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private pluginHandlers = new Map<string, Set<PluginRegistration>>();

  on(eventType: string, handler: EventHandler, pluginName?: string): () => void {
    let handlersForType = this.handlers.get(eventType);
    if (!handlersForType) {
      handlersForType = new Set<EventHandler>();
      this.handlers.set(eventType, handlersForType);
    }
    handlersForType.add(handler);

    if (pluginName) {
      let registrations = this.pluginHandlers.get(pluginName);
      if (!registrations) {
        registrations = new Set<PluginRegistration>();
        this.pluginHandlers.set(pluginName, registrations);
      }
      registrations.add({ type: eventType, handler });
    }

    return () => {
      this.removeHandler(eventType, handler);
      if (pluginName) {
        this.removePluginRegistration(pluginName, eventType, handler);
      }
    };
  }

  async emit(event: PluginEvent): Promise<void> {
    const handlersForType = this.handlers.get(event.type);
    if (!handlersForType || handlersForType.size === 0) {
      return;
    }

    for (const handler of Array.from(handlersForType)) {
      try {
        await handler(event);
      } catch {}
    }
  }

  removePlugin(pluginName: string): void {
    const registrations = this.pluginHandlers.get(pluginName);
    if (!registrations) {
      return;
    }

    for (const registration of registrations) {
      this.removeHandler(registration.type, registration.handler);
    }

    this.pluginHandlers.delete(pluginName);
  }

  clear(): void {
    this.handlers.clear();
    this.pluginHandlers.clear();
  }

  private removeHandler(eventType: string, handler: EventHandler): void {
    const handlersForType = this.handlers.get(eventType);
    if (!handlersForType) {
      return;
    }

    handlersForType.delete(handler);
    if (handlersForType.size === 0) {
      this.handlers.delete(eventType);
    }
  }

  private removePluginRegistration(pluginName: string, eventType: string, handler: EventHandler): void {
    const registrations = this.pluginHandlers.get(pluginName);
    if (!registrations) {
      return;
    }

    for (const registration of registrations) {
      if (registration.type === eventType && registration.handler === handler) {
        registrations.delete(registration);
      }
    }

    if (registrations.size === 0) {
      this.pluginHandlers.delete(pluginName);
    }
  }
}
