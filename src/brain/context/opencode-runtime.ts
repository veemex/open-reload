/**
 * OpenCode runtime detection and enriched PluginInput construction.
 *
 * When running inside OpenCode, detects the HTTP server via OPENCODE_PORT
 * env var and constructs a real OpencodeClient. Falls back to minimal
 * stubs when running standalone.
 */

export type PluginInput = {
  directory: string;
  worktree: string;
  client?: unknown;
  project?: unknown;
  serverUrl?: URL;
  $?: unknown;
};

export type RuntimeInfo = {
  detected: boolean;
  serverUrl?: string;
  hasAuth: boolean;
  hasClient: boolean;
  hasProject: boolean;
};

let cached: { cwd: string; input: PluginInput; info: RuntimeInfo } | null =
  null;

export function resetCache(): void {
  cached = null;
}

export function getRuntimeInfo(): RuntimeInfo {
  return (
    cached?.info ?? {
      detected: false,
      hasAuth: false,
      hasClient: false,
      hasProject: false,
    }
  );
}

export async function buildPluginInput(cwd: string): Promise<PluginInput> {
  if (cached && cached.cwd === cwd) return cached.input;

  const input: PluginInput = { directory: cwd, worktree: cwd };
  const info: RuntimeInfo = {
    detected: false,
    hasAuth: false,
    hasClient: false,
    hasProject: false,
  };

  try {
    if (typeof Bun !== "undefined" && Bun.$) {
      input.$ = Bun.$;
    }
  } catch {
    /* Bun.$ unavailable */
  }

  const port = process.env.OPENCODE_PORT;
  if (!port) {
    cached = { cwd, input, info };
    return input;
  }

  info.detected = true;
  const serverUrl = `http://localhost:${port}`;
  info.serverUrl = serverUrl;

  try {
    input.serverUrl = new URL(serverUrl);
  } catch {
    cached = { cwd, input, info };
    return input;
  }

  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const headers: Record<string, string> = {};
  if (password) {
    headers.Authorization = `Basic ${Buffer.from(`:${password}`).toString("base64")}`;
    info.hasAuth = true;
  }

  try {
    const { createOpencodeClient } = await import("@opencode-ai/sdk/client");
    const client = createOpencodeClient({
      baseUrl: serverUrl,
      headers,
      directory: cwd,
    });

    input.client = client;
    info.hasClient = true;

    try {
      const typedClient = client as { project: { current: () => Promise<{ data?: unknown }> } };
      const projectResult = await Promise.race([
        typedClient.project.current(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 3000)
        ),
      ]);
      if (projectResult?.data) {
        input.project = projectResult.data;
        info.hasProject = true;
      }
    } catch {
      /* project fetch non-critical */
    }
  } catch {
    /* SDK unavailable — fall back to stubs */
  }

  cached = { cwd, input, info };
  return input;
}
