import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  PackageRuntime,
  PackageRuntimeError,
  PackageManifestSchema
} from "../src/index.js";

const tempRoots: string[] = [];

describe("PackageManifestSchema", () => {
  it("accepts the legacy v1 manifest shape and normalizes contribution aliases", () => {
    const manifest = {
      schemaVersion: "1.0",
      name: "core-guide",
      version: "0.1.0",
      description: "Guide and interactive choice package",
      kind: "core",
      scopes: ["world", "session"],
      permissions: ["read:world", "read:session", "emit:block"],
      dependencies: [],
      modelPolicy: {
        preferredTier: "small"
      },
      contributes: {
        context: [
          {
            id: "guide-context",
            entry: "server/context.ts",
            reads: ["world", "session"],
            writes: []
          }
        ],
        commands: [
          {
            name: "guide",
            description: "Generate a guide block",
            argsSchema: "schemas/commands/guide.args.json",
            entry: "server/commands/guide.ts",
            resume: false
          }
        ],
        blocks: [
          {
            type: "choices",
            dataSchema: "schemas/blocks/choices.data.json",
            responseSchema: "schemas/blocks/choices.response.json",
            ui: {
              component: "schema",
              renderer: "choices"
            }
          }
        ],
        renderers: [
          {
            name: "story-image",
            entry: "client/renderers/story-image.tsx"
          }
        ],
        hooks: [],
        capabilities: [],
        artifactTypes: []
      },
      settings: [],
      state: []
    };

    expect(PackageManifestSchema.parse(manifest)).toMatchObject({
      contributes: {
        context: manifest.contributes.context,
        contextProviders: manifest.contributes.context,
        blocks: manifest.contributes.blocks,
        blockTypes: manifest.contributes.blocks,
        commands: manifest.contributes.commands,
        renderers: manifest.contributes.renderers,
        hooks: [],
        capabilities: [],
        artifactTypes: []
      }
    });
  });

  it("accepts the expanded v1 manifest shape with hooks, capabilities, artifact types, settings, and state", () => {
    const manifest = createManifest({
      contributes: {
        contextProviders: [
          {
            id: "guide-context",
            entry: "server/context.ts",
            reads: ["world", "session"],
            writes: []
          }
        ],
        commands: [],
        hooks: [
          {
            id: "guide-after-turn",
            phase: "afterNarration",
            trigger: {
              type: "event",
              event: "narration.completed"
            },
            entry: "server/hooks/after-turn.ts"
          }
        ],
        capabilities: [
          {
            id: "guide.generate",
            type: "workflow",
            entry: "server/capabilities/generate.ts",
            inputSchema: "schemas/capabilities/generate.input.json",
            outputSchema: "schemas/capabilities/generate.output.json",
            timeoutMs: 3000
          }
        ],
        blockTypes: [],
        renderers: [],
        artifactTypes: [
          {
            type: "guide-card",
            kind: "card",
            mediaType: "application/json"
          }
        ]
      },
      settings: [
        {
          key: "guide.auto",
          type: "boolean",
          default: true,
          scope: "session"
        }
      ],
      state: [
        {
          collection: "guide-state",
          scope: "session",
          schema: "schemas/state/guide-state.json"
        }
      ]
    });

    expect(PackageManifestSchema.parse(manifest)).toMatchObject({
      settings: manifest.settings,
      state: manifest.state,
      contributes: {
        hooks: manifest.contributes.hooks,
        capabilities: manifest.contributes.capabilities,
        artifactTypes: manifest.contributes.artifactTypes
      }
    });
  });

  it("rejects manifests missing required top-level fields", () => {
    const result = PackageManifestSchema.safeParse({
      schemaVersion: "1.0",
      name: "broken-package"
    });

    expect(result.success).toBe(false);
  });
});

describe("PackageRuntime", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("discovers package manifests from the filesystem without loading SKILL.md", async () => {
    const root = await createTempRoot();
    await writePackage(root, {
      manifest: createManifest({
        name: "core-guide"
      }),
      skill: "# Guide\n\nOnly load this when enabled."
    });

    const fsSpy = {
      readdir: vi.fn(async (...args: Parameters<typeof readdir>) => readdir(...args)),
      readFile: vi.fn(async (...args: Parameters<typeof readFile>) => readFile(...args)),
      stat: vi.fn(async (...args: Parameters<typeof stat>) => stat(...args))
    };

    const runtime = new PackageRuntime({
      packagesRoot: root,
      fs: fsSpy
    });

    const discovered = await runtime.discover();

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      name: "core-guide",
      enabled: false
    });
    expect(discovered[0]?.skillMarkdown).toBeUndefined();

    const reads = fsSpy.readFile.mock.calls.map(([filePath]) => String(filePath));
    expect(reads.some((filePath) => filePath.endsWith("SKILL.md"))).toBe(false);
    expect(reads.some((filePath) => filePath.endsWith("manifest.json"))).toBe(true);
  });

  it("loads SKILL.md and registers contributions only when a package is enabled", async () => {
    const root = await createTempRoot();
    await writePackage(root, {
      manifest: createManifest({
        name: "core-guide",
        contributes: {
          contextProviders: [
            {
              id: "guide-context",
              entry: "server/context.ts",
              reads: ["world", "session"],
              writes: []
            }
          ],
          commands: [
            {
              name: "guide",
              description: "Generate a guide block",
              argsSchema: "schemas/commands/guide.args.json",
              entry: "server/commands/guide.ts",
              resume: false
            }
          ],
          hooks: [
            {
              id: "guide-after-turn",
              phase: "afterNarration",
              trigger: {
                type: "event",
                event: "narration.completed"
              },
              entry: "server/hooks/after-turn.ts"
            }
          ],
          capabilities: [
            {
              id: "guide.generate",
              type: "workflow",
              entry: "server/capabilities/generate.ts",
              inputSchema: "schemas/capabilities/generate.input.json",
              outputSchema: "schemas/capabilities/generate.output.json"
            }
          ],
          blockTypes: [
            {
              type: "choices",
              dataSchema: "schemas/blocks/choices.data.json",
              responseSchema: "schemas/blocks/choices.response.json",
              ui: {
                component: "schema",
                renderer: "choices"
              }
            }
          ],
          renderers: [
            {
              name: "choices",
              entry: "client/renderers/choices.tsx"
            }
          ],
          artifactTypes: [
            {
              type: "guide-card",
              kind: "card",
              mediaType: "application/json"
            }
          ]
        }
      }),
      skill: "# Guide\n\nProgressively loaded."
    });

    const runtime = new PackageRuntime({
      packagesRoot: root
    });

    await runtime.discover();

    expect(runtime.getCommand("guide")).toBeUndefined();
    expect(runtime.getBlock("choices")).toBeUndefined();
    expect(runtime.getHook("guide-after-turn")).toBeUndefined();
    expect(runtime.getCapability("guide.generate")).toBeUndefined();

    const enabledPackage = await runtime.enable("core-guide");

    expect(enabledPackage.enabled).toBe(true);
    expect(enabledPackage.skillMarkdown).toContain("Progressively loaded");
    expect(runtime.getContextProvider("guide-context")).toMatchObject({
      id: "guide-context",
      packageName: "core-guide"
    });
    expect(runtime.getContextProvider("guide-context")?.build).toBeTypeOf("function");
    expect(runtime.getCommand("guide")).toMatchObject({
      name: "guide",
      packageName: "core-guide"
    });
    expect(runtime.getHook("guide-after-turn")).toMatchObject({
      id: "guide-after-turn",
      packageName: "core-guide"
    });
    expect(runtime.getCapability("guide.generate")).toMatchObject({
      id: "guide.generate",
      packageName: "core-guide"
    });
    expect(runtime.getBlock("choices")).toMatchObject({
      type: "choices",
      packageName: "core-guide"
    });
    expect(runtime.getRenderer("choices")).toMatchObject({
      name: "choices",
      packageName: "core-guide"
    });
    expect(runtime.getArtifactType("guide-card")).toMatchObject({
      type: "guide-card",
      packageName: "core-guide"
    });
  });

  it("unregisters package contributions when disabled", async () => {
    const root = await createTempRoot();
    await writePackage(root, {
      manifest: createManifest({
        name: "core-guide",
        contributes: {
          contextProviders: [],
          commands: [
            {
              name: "guide",
              description: "Generate a guide block",
              argsSchema: "schemas/commands/guide.args.json",
              entry: "server/commands/guide.ts",
              resume: false
            }
          ],
          hooks: [],
          capabilities: [],
          blockTypes: [],
          renderers: [],
          artifactTypes: []
        }
      }),
      skill: "# Guide"
    });

    const runtime = new PackageRuntime({
      packagesRoot: root
    });

    await runtime.discover();
    await runtime.enable("core-guide");

    expect(runtime.getCommand("guide")).toBeDefined();

    runtime.disable("core-guide");

    expect(runtime.getCommand("guide")).toBeUndefined();
    expect(runtime.getPackage("core-guide")).toMatchObject({
      enabled: false
    });
  });

  it("rejects path traversal in registered entries and schema paths", async () => {
    const root = await createTempRoot();
    await writePackage(root, {
      manifest: createManifest({
        name: "unsafe-package",
        contributes: {
          contextProviders: [],
          commands: [
            {
              name: "unsafe",
              description: "Unsafe command",
              argsSchema: "../schemas/commands/unsafe.args.json",
              entry: "server/commands/unsafe.ts",
              resume: false
            }
          ],
          hooks: [
            {
              id: "unsafe-hook",
              phase: "afterNarration",
              entry: "../server/hooks/unsafe.ts"
            }
          ],
          capabilities: [
            {
              id: "unsafe-capability",
              type: "script",
              entry: "server/capabilities/unsafe.ts",
              inputSchema: "../schemas/capabilities/unsafe.input.json",
              outputSchema: "schemas/capabilities/unsafe.output.json"
            }
          ],
          blockTypes: [
            {
              type: "unsafe-block",
              dataSchema: "schemas/blocks/unsafe.data.json",
              responseSchema: "../../outside/unsafe.response.json",
              ui: {
                component: "schema",
                renderer: "unsafe"
              }
            }
          ],
          renderers: [],
          artifactTypes: []
        }
      }),
      skill: "# Unsafe"
    });

    const runtime = new PackageRuntime({
      packagesRoot: root
    });

    await runtime.discover();

    await expect(runtime.enable("unsafe-package")).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_BLOCKED"
    });
  });
});

function createManifest(
  overrides: Partial<{
    name: string;
    kind: string;
    dependencies: string[];
    contributes: {
      contextProviders: Array<{
        id: string;
        entry: string;
        reads: string[];
        writes: string[];
      }>;
      commands: Array<{
        name: string;
        description: string;
        argsSchema: string;
        entry: string;
        resume: boolean;
      }>;
      hooks: Array<{
        id: string;
        phase: string;
        trigger?: Record<string, unknown>;
        entry: string;
      }>;
      capabilities: Array<{
        id: string;
        type: "builtin" | "script" | "model" | "workflow" | "job";
        entry: string;
        inputSchema: string;
        outputSchema: string;
        timeoutMs?: number;
      }>;
      blockTypes: Array<{
        type: string;
        dataSchema: string;
        responseSchema: string;
        ui: {
          component: "schema";
          renderer: string;
        };
      }>;
      renderers: Array<{
        name: string;
        entry: string;
      }>;
      artifactTypes: Array<{
        type: string;
        kind: string;
        mediaType: string;
      }>;
    };
    settings: Array<{
      key: string;
      type: string;
      default?: unknown;
      scope: string;
    }>;
    state: Array<{
      collection: string;
      scope: string;
      schema: string;
    }>;
  }> = {}
) {
  return {
    schemaVersion: "1.0",
    name: overrides.name ?? "core-guide",
    version: "0.1.0",
    description: "Guide and interactive choice package",
    kind: overrides.kind ?? "core",
    defaultEnabled: true,
    scopes: ["world", "session"],
    permissions: ["read:world", "read:session", "emit:block"],
    dependencies: overrides.dependencies ?? [],
    modelPolicy: {
      preferredTier: "small"
    },
    contributes: overrides.contributes ?? {
      contextProviders: [],
      commands: [],
      hooks: [],
      capabilities: [],
      blockTypes: [],
      renderers: [],
      artifactTypes: []
    },
    settings: overrides.settings ?? [],
    state: overrides.state ?? []
  };
}

async function createTempRoot() {
  const root = await mkdtemp(join(tmpdir(), "package-runtime-"));
  tempRoots.push(root);
  return root;
}

async function writePackage(
  packagesRoot: string,
  input: {
    manifest: ReturnType<typeof createManifest>;
    skill: string;
  }
) {
  const packageRoot = join(packagesRoot, input.manifest.name);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "manifest.json"), JSON.stringify(input.manifest, null, 2), "utf8");
  await writeFile(join(packageRoot, "SKILL.md"), input.skill, "utf8");

  for (const command of input.manifest.contributes.commands) {
    const commandPath = join(packageRoot, command.entry);
    await mkdir(dirname(commandPath), { recursive: true });
    await writeFile(
      commandPath,
      [
        "export const command = {",
        "  argsSchema: {",
        "    safeParse(value) {",
        "      return { success: true, data: value ?? {} };",
        "    }",
        "  },",
        "  async execute() {",
        `    return { content: \"${command.name} executed\" };`,
        "  }",
        "};"
      ].join("\n"),
      "utf8"
    );

    const schemaPath = join(packageRoot, command.argsSchema);
    await mkdir(dirname(schemaPath), { recursive: true });
    await writeFile(schemaPath, JSON.stringify({ type: "object" }, null, 2), "utf8");
  }

  for (const contextProvider of input.manifest.contributes.contextProviders ?? []) {
    const contextPath = join(packageRoot, contextProvider.entry);
    await mkdir(dirname(contextPath), { recursive: true });
    await writeFile(
      contextPath,
      [
        "export const contextProvider = {",
        "  async build() {",
        "    return [];",
        "  }",
        "};"
      ].join("\n"),
      "utf8"
    );
  }

  for (const hook of input.manifest.contributes.hooks ?? []) {
    const hookPath = join(packageRoot, hook.entry);
    await mkdir(dirname(hookPath), { recursive: true });
    await writeFile(
      hookPath,
      [
        "export const hook = {",
        "  async execute() {",
        `    return { hookId: \"${hook.id}\" };`,
        "  }",
        "};"
      ].join("\n"),
      "utf8"
    );
  }

  for (const capability of input.manifest.contributes.capabilities ?? []) {
    const capabilityPath = join(packageRoot, capability.entry);
    await mkdir(dirname(capabilityPath), { recursive: true });
    await writeFile(
      capabilityPath,
      [
        "export const capability = {",
        "  async execute() {",
        `    return { capabilityId: \"${capability.id}\" };`,
        "  }",
        "};"
      ].join("\n"),
      "utf8"
    );

    const inputSchemaPath = join(packageRoot, capability.inputSchema);
    await mkdir(dirname(inputSchemaPath), { recursive: true });
    await writeFile(inputSchemaPath, JSON.stringify({ type: "object" }, null, 2), "utf8");

    const outputSchemaPath = join(packageRoot, capability.outputSchema);
    await mkdir(dirname(outputSchemaPath), { recursive: true });
    await writeFile(outputSchemaPath, JSON.stringify({ type: "object" }, null, 2), "utf8");
  }

  for (const block of input.manifest.contributes.blockTypes ?? []) {
    const dataSchemaPath = join(packageRoot, block.dataSchema);
    await mkdir(dirname(dataSchemaPath), { recursive: true });
    await writeFile(dataSchemaPath, JSON.stringify({ type: "object" }, null, 2), "utf8");

    const responseSchemaPath = join(packageRoot, block.responseSchema);
    await mkdir(dirname(responseSchemaPath), { recursive: true });
    await writeFile(responseSchemaPath, JSON.stringify({ type: "object" }, null, 2), "utf8");
  }

  for (const state of input.manifest.state ?? []) {
    const stateSchemaPath = join(packageRoot, state.schema);
    await mkdir(dirname(stateSchemaPath), { recursive: true });
    await writeFile(stateSchemaPath, JSON.stringify({ type: "object" }, null, 2), "utf8");
  }
}
