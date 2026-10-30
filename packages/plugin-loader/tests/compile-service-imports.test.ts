/**
 * An agent's `agent.tools.services` imports compile to `{ contract, name }`,
 * with the tool name derived once. A name that cannot be a tool, or that
 * clashes with another tool of the runtime or package, is an error at its
 * field.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runtimeAuthoringManifestSchema,
  type PluginManifest,
  type RuntimeAuthoringManifest,
} from "@covel/shared";
import { compileRuntimeManifest } from "../src/compile-manifest.js";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";

const plugin: PluginManifest = {
  id: "probe",
  kind: "plugin",
  description: "Probe",
};

const staged = { schedule: { stage: "narrative" as const } };

function compile(runtime: RuntimeAuthoringManifest) {
  return compileRuntimeManifest(plugin, runtime, "probe/teller");
}

/** The issues the authoring schema reports, as `path: message`. */
function issues(runtime: unknown): string[] {
  const result = runtimeAuthoringManifestSchema.safeParse(runtime);
  return result.success
    ? []
    : result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
}

describe("compiled service imports", () => {
  it("derives a versionless name from the contract, or takes as", () => {
    const manifest = compile({
      ...staged,
      agent: {
        tools: {
          services: [
            "inventory.items@1",
            { contract: "world.map-lookup@2" },
            { contract: "rank.score@1", as: "score_it" },
          ],
        },
      },
    });
    expect(manifest.tools?.services).toEqual([
      { contract: "inventory.items@1", name: "inventory-items" },
      { contract: "world.map-lookup@2", name: "world-map-lookup" },
      { contract: "rank.score@1", name: "score_it" },
    ]);
  });

  it("keeps the single-runtime default for the package's own tools", () => {
    const manifest = compileRuntimeManifest(
      { ...plugin, contributes: { tools: ["note"] } },
      { ...staged, agent: { tools: { services: ["inventory.items@1"] } } },
      "probe",
    );
    expect(manifest.tools).toEqual({
      plugin: ["note"],
      services: [{ contract: "inventory.items@1", name: "inventory-items" }],
    });
  });
});

describe("service import rules", () => {
  it("needs as when the derived name is too long", () => {
    const contract = `a${".b".repeat(40)}@1`;
    expect(
      issues({ ...staged, agent: { tools: { services: [contract] } } }),
    ).toEqual([
      expect.stringMatching(
        /^agent\.tools\.services\.0: the tool name ".*" derived from .* is not a valid tool name/,
      ),
    ]);
    expect(
      issues({
        ...staged,
        agent: { tools: { services: [{ contract, as: "short" }] } },
      }),
    ).toEqual([]);
  });

  it.each([
    {
      case: "a framework tool",
      agent: { tools: { services: [{ contract: "x.y@1", as: "suspend" }] } },
      field: "agent.tools.services.0.as",
    },
    {
      case: "a builtin the runtime declares",
      agent: {
        tools: {
          builtin: ["memory-search"],
          services: [{ contract: "memory.search@1", as: "memory-search" }],
        },
      },
      field: "agent.tools.services.0.as",
    },
    {
      case: "a plugin tool the runtime declares",
      agent: {
        tools: { plugin: ["inventory-items"], services: ["inventory.items@1"] },
      },
      field: "agent.tools.services.0",
    },
    {
      case: "another import",
      agent: {
        tools: {
          services: [
            "inventory.items@1",
            { contract: "bags.list@1", as: "inventory-items" },
          ],
        },
      },
      field: "agent.tools.services.1.as",
    },
    {
      case: "the same contract twice",
      agent: {
        tools: {
          services: [
            "inventory.items@1",
            { contract: "inventory.items@1", as: "other" },
          ],
        },
      },
      field: "agent.tools.services.1",
    },
    {
      case: "a completing tool",
      agent: {
        tools: { services: ["inventory.items@1"] },
        completion: { require: "tool-use", afterTools: ["inventory-items"] },
      },
      field: "agent.completion.afterTools.0",
    },
    {
      case: "finishWith",
      agent: {
        tools: { services: ["inventory.items@1"] },
        finishWith: "inventory-items",
      },
      field: "agent.finishWith",
    },
  ])("rejects a clash with $case at $field", ({ agent, field }) => {
    const found = issues({ ...staged, agent });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(new RegExp(`^${field.replace(/\./g, "\\.")}: `));
  });

  it("rejects imports in a function runtime", () => {
    expect(
      issues({
        schedule: { stage: "narrative" },
        function: { tools: { services: ["inventory.items@1"] } },
      }),
    ).toEqual([expect.stringMatching(/^function\.tools: Unrecognized key/)]);
  });

  it("applies the same rules to the compiled manifest", () => {
    expect(() =>
      compile({
        ...staged,
        agent: { tools: { services: [{ contract: "x.y@1", as: "suspend" }] } },
      }),
    ).toThrow("framework tool");
  });
});

describe("package checks", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("rejects an import named like a tool the package contributes", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "covel-imports-"));
    roots.push(temp);
    const dir = path.join(temp, "probe");
    await mkdir(path.join(dir, "runtimes", "teller"), { recursive: true });
    await writeFile(
      path.join(dir, "PLUGIN.md"),
      `---\n${JSON.stringify({
        id: "probe",
        kind: "plugin",
        description: "Probe",
        contributes: { tools: ["inventory-items"] },
      })}\n---\n`,
    );
    await writeFile(path.join(dir, "entry.js"), "export default () => {};\n");
    await writeFile(
      path.join(dir, "runtimes", "teller", "RUNTIME.md"),
      `---\n${JSON.stringify({
        ...staged,
        agent: { tools: { services: ["inventory.items@1"] } },
      })}\n---\nTell.\n`,
    );
    let stderr = "";
    const status = await runValidateManifest([dir], {
      stdout: { write: () => true },
      stderr: { write: (text) => (stderr += text) },
    });
    expect(status).toBe(1);
    expect(stderr).toContain(
      'agent.tools.services.0: the imported tool "inventory-items" has the name of a tool in contributes.tools',
    );
  });
});
