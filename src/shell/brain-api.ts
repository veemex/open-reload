export type ToolSpec = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type ToolCallContext = {
  cwd: string;
  sessionId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
};

export type ToolCall = {
  name: string;
  arguments?: unknown;
  context?: ToolCallContext;
};

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type FileEvent = {
  path: string;
  kind: "create" | "change" | "delete" | "rename";
};

export type WatchPlan = {
  roots: string[];
  recursive: boolean;
  debounceMs: number;
  ignore: string[];
};

// JSON-serializable only — survives brain reload
export type BrainSnapshot = Record<string, unknown>;

export type BrainContext = {
  cwd: string;
  nowMs(): number;
  logErr(line: string): void;
};

export type BrainInit = {
  snapshot?: BrainSnapshot;
  configPath?: string;
};

export type FileEventEffects = {
  reloadBrain?: boolean;
  refreshWatchPlan?: boolean;
};

export type BrainAPI = {
  listTools(): Promise<ToolSpec[]>;
  callTool(call: ToolCall): Promise<ToolResult>;
  getWatchPlan(): Promise<WatchPlan>;
  onFileEvents(events: FileEvent[]): Promise<FileEventEffects>;
  exportSnapshot(): Promise<BrainSnapshot>;
  dispose(): Promise<void>;
};

export type BrainFactory = {
  create(ctx: BrainContext, init: BrainInit): Promise<BrainAPI>;
};
