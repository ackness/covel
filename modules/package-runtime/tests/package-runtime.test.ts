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
  it("accepts the v1 minimal manifest shape", () => {
    const manifest = {
      schemaVersion: "1.0",
      name: "core-guide",
      version: "0.1.0",
      description: "Guide and interactive choice package",
      scopes: ["world", "session"],
      permissions: ["read:world", "read:session", "emit:block"],
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
        ]
      }
    };

    expect(PackageManifestSchema.parse(manifest)).toEqual(manifest);
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
              name: "choices",
              entry: "client/renderers/choices.tsx"
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

    const enabledPackage = await runtime.enable("core-guide");

    expect(enabledPackage.enabled).toBe(true);
    expect(enabledPackage.skillMarkdown).toContain("Progressively loaded");
    expect(runtime.getContextProvider("guide-context")).toMatchObject({
      id: "guide-context",
      packageName: "core-guide"
    });
    expect(runtime.getCommand("guide")).toMatchObject({
      name: "guide",
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
  });

  it("unregisters package contributions when disabled", async () => {
    const root = await createTempRoot();
    await writePackage(root, {
      manifest: createManifest({
        name: "core-guide",
        contributes: {
          context: [],
          commands: [
            {
              name: "guide",
              description: "Generate a guide block",
              argsSchema: "schemas/commands/guide.args.json",
              entry: "server/commands/guide.ts",
              resume: false
            }
          ],
          blocks: [],
          renderers: []
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
          context: [],
          commands: [
            {
              name: "unsafe",
              description: "Unsafe command",
              argsSchema: "../schemas/commands/unsafe.args.json",
              entry: "server/commands/unsafe.ts",
              resume: false
            }
          ],
          blocks: [
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
          renderers: []
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
    contributes: {
      context: Array<{
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
      blocks: Array<{
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
    };
  }> = {}
) {
  return {
    schemaVersion: "1.0",
    name: overrides.name ?? "core-guide",
    version: "0.1.0",
    description: "Guide and interactive choice package",
    scopes: ["world", "session"],
    permissions: ["read:world", "read:session", "emit:block"],
    modelPolicy: {
      preferredTier: "small"
    },
    contributes: overrides.contributes ?? {
      context: [],
      commands: [],
      blocks: [],
      renderers: []
    }
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
}
