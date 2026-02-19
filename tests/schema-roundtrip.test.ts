import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { z } from "zod";
import type { PluginConfig } from "../src/brain/config/types.ts";
import { loadPluginModule } from "../src/brain/loader/module-loader.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(PROJECT_ROOT, ".tmp-schema-rt-"));
  tempDirs.push(dir);
  return dir;
}

function writePluginFile(dir: string, source: string): string {
  const pluginPath = join(dir, "plugin.ts");
  writeFileSync(pluginPath, source);
  return pluginPath;
}

function makeConfig(
  entry: string,
  exportType: PluginConfig["exportType"],
  name = "rt"
): PluginConfig {
  return { name, entry, exportType };
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("schema round-trip: opencode-plugin format", () => {
  it("preserves field names through zodInputSchema", async () => {
    const tempDir = makeTempDir();
    const pluginPath = writePluginFile(
      tempDir,
      `
import { z } from "zod";

export default async () => ({
  tool: {
    new_task: {
      description: "Create a new isolated task environment",
      args: {
        branch: z.string().describe("Branch name for the new environment"),
        profile: z.string().optional().describe("Profile to use"),
        configPath: z.string().optional().describe("Path to workspace config"),
        baseBranch: z.string().optional().describe("Base branch to fork from"),
      },
      execute: async (args) => JSON.stringify(args),
    },
  },
});
`
    );

    const { tools } = await loadPluginModule(makeConfig(pluginPath, "opencode-plugin"));
    const newTask = tools.find((t) => t.originalName === "new_task");

    expect(newTask).toBeDefined();
    expect(newTask?.zodInputSchema).toBeDefined();

    const jsonSchema = z.toJSONSchema(newTask?.zodInputSchema as z.ZodTypeAny) as Record<
      string,
      unknown
    >;
    expect(jsonSchema.type).toBe("object");

    const props = jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toContain("branch");
    expect(Object.keys(props)).toContain("profile");
    expect(Object.keys(props)).toContain("configPath");
    expect(Object.keys(props)).toContain("baseBranch");
  });

  it("preserves parameter descriptions through the round-trip", async () => {
    const tempDir = makeTempDir();
    const pluginPath = writePluginFile(
      tempDir,
      `
import { z } from "zod";

export default async () => ({
  tool: {
    search: {
      description: "Searches records",
      args: {
        query: z.string().describe("The search query string"),
        limit: z.number().optional().describe("Maximum results to return"),
        caseSensitive: z.boolean().optional().describe("Whether search is case-sensitive"),
      },
      execute: async (args) => String(args.query ?? ""),
    },
  },
});
`
    );

    const { tools } = await loadPluginModule(makeConfig(pluginPath, "opencode-plugin"));
    const search = tools.find((t) => t.originalName === "search");

    expect(search?.zodInputSchema).toBeDefined();

    const jsonFromZod = z.toJSONSchema(search?.zodInputSchema as z.ZodTypeAny) as Record<
      string,
      unknown
    >;
    const propsFromZod = jsonFromZod.properties as Record<string, Record<string, unknown>>;
    expect(propsFromZod.query?.description).toBe("The search query string");
    expect(propsFromZod.limit?.description).toBe("Maximum results to return");
    expect(propsFromZod.caseSensitive?.description).toBe("Whether search is case-sensitive");

    const propsFromInput = search?.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(propsFromInput.query?.description).toBe("The search query string");
    expect(propsFromInput.limit?.description).toBe("Maximum results to return");
    expect(propsFromInput.caseSensitive?.description).toBe("Whether search is case-sensitive");
  });

  it("cross-version Zod v4 compatibility — raw shapes work with z.object()", async () => {
    const rawShapes = {
      name: z.string().describe("A person's name"),
      age: z.number().optional().describe("Age in years"),
      active: z.boolean().describe("Is active"),
    };

    const zodObj = z.object(rawShapes);
    expect(zodObj).toBeDefined();

    const jsonSchema = z.toJSONSchema(zodObj) as Record<string, unknown>;
    expect(jsonSchema.type).toBe("object");

    const props = jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.name?.description).toBe("A person's name");
    expect(props.age?.description).toBe("Age in years");
    expect(props.active?.description).toBe("Is active");

    const required = jsonSchema.required as string[] | undefined;
    expect(required).toContain("name");
    expect(required).toContain("active");
    expect(required).not.toContain("age");
  });

  it("z.fromJSONSchema round-trip for tool-array format", async () => {
    const tempDir = makeTempDir();
    const pluginPath = writePluginFile(
      tempDir,
      `
export const tools = [
  {
    name: "deploy",
    description: "Deploys an environment",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Deployment target" },
        dryRun: { type: "boolean", description: "Run without side effects" },
        replicas: { type: "number", description: "Number of replicas" },
      },
      required: ["target"],
    },
    execute: async (input) => String(input.target ?? ""),
  },
];
`
    );

    const { tools } = await loadPluginModule(makeConfig(pluginPath, "tool-array"));
    const deploy = tools.find((t) => t.originalName === "deploy");

    expect(deploy).toBeDefined();
    expect(deploy?.zodInputSchema).toBeDefined();

    const roundTripped = z.toJSONSchema(deploy?.zodInputSchema as z.ZodTypeAny) as Record<
      string,
      unknown
    >;
    expect(roundTripped.type).toBe("object");

    const rtProps = roundTripped.properties as Record<string, Record<string, unknown>>;
    expect(rtProps.target?.type).toBe("string");
    expect(rtProps.target?.description).toBe("Deployment target");
    expect(rtProps.dryRun?.type).toBe("boolean");
    expect(rtProps.dryRun?.description).toBe("Run without side effects");
    expect(rtProps.replicas?.type).toBe("number");
    expect(rtProps.replicas?.description).toBe("Number of replicas");

    const origProps = deploy?.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(origProps.target?.description).toBe("Deployment target");
  });
});
