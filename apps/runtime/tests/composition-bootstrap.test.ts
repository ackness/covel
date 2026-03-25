import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRuntimeComposition } from "../src/composition.js";

const FIRST_PARTY_PACKAGES = [
  "core-archive",
  "core-character-card",
  "core-debug-commands",
  "core-guide",
  "core-memory-rag",
  "core-persona",
  "core-presets",
  "core-worldbook"
];

const REQUIRED_COMMANDS = [
  "guide",
  "archive",
  "packages",
  "trace",
  "memory",
  "session"
];

const PROVIDER_ENV_KEYS = [
  "LIVE_LLM_PROVIDER",
  "LIVE_LLM_PRIMARY_BASE_URL",
  "LIVE_LLM_PRIMARY_API_KEY",
  "LIVE_LLM_PRIMARY_MODEL",
  "LIVE_LLM_SECONDARY_MODEL",
  "LIVE_LLM_EMBED_MODEL",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_MODEL",
  "DASHSCOPE_BASE_URL",
  "DASHSCOPE_API_KEY"
];

describe("runtime composition bootstrapping", () => {
  it("composes a command registry with the required built-ins and first-party package commands", async () => {
    await withRuntimeEnvironment(clearProviderEnvironment(), async () => {
      const composition = await createRuntimeComposition({
        env: process.env
      });

      expect(composition.commandRegistry.listHelp().map((entry) => entry.name)).toEqual(
        expect.arrayContaining(REQUIRED_COMMANDS)
      );
    });
  });

  it("discovers and enables first-party packages from the extensions directory", async () => {
    await withRuntimeEnvironment(clearProviderEnvironment(), async () => {
      const composition = await createRuntimeComposition({
        env: process.env
      });
      const packages = composition.packageRuntime.listPackages() as Array<{
        name: string;
        enabled: boolean;
      }>;

      expect(packages.map((pkg) => pkg.name)).toEqual(
        expect.arrayContaining(FIRST_PARTY_PACKAGES)
      );
      expect(
        packages
          .filter((pkg) => FIRST_PARTY_PACKAGES.includes(pkg.name))
          .every((pkg) => pkg.enabled)
      ).toBe(true);
    });
  });

  it("falls back to a deterministic demo model gateway when provider env is missing", async () => {
    await withRuntimeEnvironment(clearProviderEnvironment(), async () => {
      const composition = await createRuntimeComposition({
        env: process.env
      });

      const first = await composition.modelGateway.generateText({
        presetId: "default-story",
        messages: [
          {
            role: "user",
            content: "Describe the runtime fallback."
          }
        ]
      });
      const second = await composition.modelGateway.generateText({
        presetId: "default-story",
        messages: [
          {
            role: "user",
            content: "Describe the runtime fallback."
          }
        ]
      });

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        text: expect.any(String),
        finishReason: expect.any(String),
        usage: {
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number)
        }
      });
    });
  });

  it("builds a real openai-compatible provider registry config when DashScope env is present", async () => {
    await withRuntimeEnvironment(
      {
        ...clearProviderEnvironment(),
        LIVE_LLM_PROVIDER: "dashscope",
        LIVE_LLM_PRIMARY_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        LIVE_LLM_PRIMARY_API_KEY: "dashscope-test-key",
        LIVE_LLM_PRIMARY_MODEL: "qwen3.5-flash"
      },
      async () => {
        const composition = await createRuntimeComposition({
          env: process.env
        });
        const target = composition.profileRegistry.resolveTextTarget({});
        const resolved = composition.providerRegistry.resolve(target.preset ?? target.profile);

        expect(target.preset ?? target.profile).toMatchObject({
          provider: "openaiCompatible"
        });
        expect(resolved.config).toMatchObject({
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "dashscope-test-key"
        });
      }
    );
  });

  it("does not auto-enable unapproved packages discovered under extensions", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "covel-runtime-composition-"));

    try {
      await mkdir(join(tempRoot, "extensions", "unsafe-package", "server", "commands"), { recursive: true });
      await mkdir(join(tempRoot, "extensions", "unsafe-package", "schemas", "commands"), { recursive: true });
      await writeFile(join(tempRoot, "extensions", "unsafe-package", "manifest.json"), JSON.stringify({
        schemaVersion: "1.0",
        name: "unsafe-package",
        version: "0.1.0",
        description: "Unsafe package",
        scopes: ["session"],
        permissions: [],
        modelPolicy: {
          preferredTier: "small"
        },
        contributes: {
          context: [],
          commands: [
            {
              name: "unsafe",
              description: "Unsafe command",
              argsSchema: "schemas/commands/unsafe.args.json",
              entry: "server/commands/unsafe.ts",
              resume: false
            }
          ],
          blocks: [],
          renderers: []
        }
      }, null, 2));
      await writeFile(join(tempRoot, "extensions", "unsafe-package", "SKILL.md"), "# Unsafe");
      await writeFile(join(tempRoot, "extensions", "unsafe-package", "schemas", "commands", "unsafe.args.json"), JSON.stringify({ type: "object" }));
      await writeFile(join(tempRoot, "extensions", "unsafe-package", "server", "commands", "unsafe.ts"), [
        "import { z } from \"zod\";",
        "",
        "export const command = {",
        "  argsSchema: z.object({ _: z.array(z.string()).default([]) }),",
        "  async execute() {",
        "    return { content: \"unsafe\" };",
        "  }",
        "};",
        ""
      ].join("\n"));

      const composition = await createRuntimeComposition({
        cwd: tempRoot,
        env: {}
      });

      expect(composition.packageRuntime.listPackages()).toEqual([
        expect.objectContaining({
          name: "unsafe-package",
          enabled: false
        })
      ]);
      expect(composition.commandRegistry.listHelp().map((entry) => entry.name)).toEqual(["help"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function clearProviderEnvironment(): Record<string, undefined> {
  return Object.fromEntries(PROVIDER_ENV_KEYS.map((key) => [key, undefined])) as Record<string, undefined>;
}

async function withRuntimeEnvironment<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const previousEntries = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previousEntries.set(key, process.env[key]);

    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  vi.resetModules();

  try {
    return await run();
  } finally {
    for (const [key, value] of previousEntries) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }

    vi.resetModules();
  }
}
