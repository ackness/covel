import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  characterActorOutputJsonSchema,
  runtimeAuthoringManifestSchema,
  serviceContributionSchema,
} from "@covel/shared";
import { discoverPlugins } from "../src/discover.js";
import { loadRuntime, loadPluginDefinition } from "../src/load.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});
async function fixture(schema?: string, shadow?: boolean) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "orch-loader-")),
  );
  roots.push(root);
  const dir = path.join(root, "sample");
  await fs.mkdir(dir);
  const manifest = {
    id: "sample",
    kind: "plugin",
    description: "Sample actor",
    ...(shadow
      ? { contracts: { "character-actor@1": { schema: "weak.json" } } }
      : {}),
    runtime: {
      schedule: { subagentOnly: true },
      io: {
        output: {
          contract: "character-actor@1",
          ...(schema ? { schema } : {}),
        },
      },
    },
  };
  await fs.writeFile(
    path.join(dir, "PLUGIN.md"),
    `---\n${Object.entries(manifest)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n")}\n---\nPlay the chosen character.\n`,
  );
  await fs.writeFile(
    path.join(dir, "weak.json"),
    JSON.stringify({ type: "object" }),
  );
  const [discovery] = await discoverPlugins(root);
  if (!discovery) throw new Error("Missing fixture");
  return discovery;
}
describe("framework actor contract", () => {
  it.each([undefined, "contract:character-actor@1"])(
    "loads the canonical schema with declaration %s",
    async (schema) => {
      const loaded = await loadRuntime(await fixture(schema), "sample");
      expect(loaded.outputSchema).toEqual(characterActorOutputJsonSchema());
      expect(loaded.outputContractSchema).toEqual(
        characterActorOutputJsonSchema(),
      );
      expect(loaded.manifest.trigger).toEqual({ type: "manual" });
    },
  );
  it("retains canonical validation beside a weaker explicit schema", async () => {
    const loaded = await loadRuntime(await fixture("weak.json"), "sample");
    expect(loaded.outputContractSchema).toEqual(
      characterActorOutputJsonSchema(),
    );
  });
  it("refuses package schema shadowing", async () => {
    await expect(
      loadPluginDefinition(await fixture(undefined, true)),
    ).rejects.toThrow(/framework-owned/);
  });
  it.each([
    { schedule: {} },
    { schedule: { subagentOnly: true }, function: { handler: "run.ts" } },
    { schedule: { subagentOnly: true }, io: { visibility: "story" } },
  ])("rejects incompatible actor declarations %j", (extra) => {
    const declaration = {
      ...extra,
      io: {
        ...("io" in extra ? extra.io : {}),
        output: { contract: "character-actor@1" },
      },
    };
    expect(runtimeAuthoringManifestSchema.safeParse(declaration).success).toBe(
      false,
    );
  });
  it("reserves policy services for read access", () => {
    expect(
      serviceContributionSchema.safeParse({
        contract: "turn-policy@1",
        access: "write",
      }).success,
    ).toBe(false);
    expect(
      serviceContributionSchema.safeParse("character-actor@1").success,
    ).toBe(false);
    expect(serviceContributionSchema.safeParse("turn-policy@1").success).toBe(
      true,
    );
  });
});
