import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildImportPlan } from "../../src/world-data/session-import/planning.js";
import type { OrderedWorldDataSource } from "../../src/world-data/types.js";
import {
  makePlugin,
  makeSource,
  NOW,
  registry,
  VALID_WORLD_IR,
  WORLD_IR_SCHEMA,
} from "./world-data-projection-fixtures.js";

describe("world data projections", () => {
  it("fans out WorldIR to active plugins in stable plugin/projection/output order", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-plugins-"),
    );
    const alpha = await makePlugin({
      root: pluginsRoot,
      id: "alpha",
      handlers: {
        "a.mjs": `export default ({ value, context }) => ({ notes: [{ id: "alpha-a", kind: value.entities[0].type, context }] });`,
        "z.mjs": `export default ({ context }) => ({ rules: { id: "alpha-z-rule", context }, notes: { id: "alpha-z-note", context } });`,
      },
      projections: {
        z_projection: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/z.mjs",
          outputs: {
            rules: { namespace: "rules", key: "id" },
            notes: { namespace: "notes", key: "id" },
          },
        },
        a_projection: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/a.mjs",
          outputs: { notes: { namespace: "notes", key: "id" } },
        },
      },
      namespaces: ["notes", "rules"],
    });
    const zeta = await makePlugin({
      root: pluginsRoot,
      id: "zeta",
      handlers: {
        "main.mjs": `export default ({ value }) => ({ facts: value.statements.map(({ id, type }) => ({ id: "zeta-" + id, kind: type })) });`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      locale: "zh-CN",
      deps: {
        activePlugins: ["zeta", "alpha"],
        registry: registry([zeta, alpha]),
      },
    });

    expect(plan.diagnostics.filter((item) => item.level === "error")).toEqual(
      [],
    );
    expect(
      plan.writes.map((write) =>
        write.kind === "plugin-data"
          ? `${write.pluginId}:${write.namespace}:${write.key}`
          : write.kind,
      ),
    ).toEqual([
      "alpha:notes:alpha-a",
      "alpha:notes:alpha-z-note",
      "alpha:rules:alpha-z-rule",
      "zeta:facts:zeta-harbor-rule",
    ]);
    expect(plan.writes[0]).toMatchObject({
      source: { id: "world-ir" },
      derivedFrom: [
        "world-ir",
        "projection:alpha/a_projection",
        "output:notes",
      ],
      value: {
        context: {
          sessionId: "sess-1",
          worldId: "world-1",
          sourceId: "world-ir",
          locale: "zh-CN",
          now: NOW,
        },
      },
    });
  });

  it("does not execute inactive projections and allows zero active outputs", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-inactive-"),
    );
    const inactive = await makePlugin({
      root: pluginsRoot,
      id: "inactive",
      handlers: {
        "throw.mjs": `export default () => { throw new Error("must not run"); };`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/throw.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      deps: {
        activePlugins: [],
        registry: registry([inactive]),
      },
    });

    expect(plan.writes).toEqual([]);
    expect(plan.diagnostics.filter((item) => item.level === "error")).toEqual(
      [],
    );
  });

  it("never executes handlers during read-only preflight", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-preflight-"),
    );
    const marker = path.join(pluginsRoot, "handler-ran");
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "facts",
      handlers: {
        "main.mjs": `import { writeFile } from "node:fs/promises"; export default async () => { await writeFile(${JSON.stringify(marker)}, "ran"); return { facts: { id: "fact" } }; };`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      deps: {
        activePlugins: ["facts"],
        registry: registry([plugin]),
        executeProjectionHandlers: false,
      },
    });

    expect(plan.writes).toEqual([]);
    expect(plan.diagnostics.map((item) => item.message).join("\n")).toContain(
      "handler execution is deferred",
    );
    await expect(access(marker)).rejects.toThrow();
  });

  it("requires explicit approval for community server code", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-community-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "community-facts",
      source: "community",
      handlers: {
        "main.mjs": `export default () => ({ facts: { id: "approved" } });`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
    });
    const source = await makeSource(VALID_WORLD_IR);
    const denied = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [source],
      now: NOW,
      deps: {
        activePlugins: ["community-facts"],
        registry: registry([plugin]),
      },
    });
    expect(denied.writes).toEqual([]);
    expect(denied.diagnostics.map((item) => item.message).join("\n")).toContain(
      "requires an explicit session server-code approval",
    );
    expect(denied.diagnostics.every((item) => item.level !== "error")).toBe(
      true,
    );

    const approved = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [source],
      now: NOW,
      deps: {
        activePlugins: ["community-facts"],
        registry: registry([plugin]),
        canExecuteProjection: (pluginId) => pluginId === "community-facts",
      },
    });
    expect(approved.writes).toEqual([
      expect.objectContaining({
        pluginId: "community-facts",
        namespace: "facts",
        key: "approved",
      }),
    ]);
  });

  it("isolates handler input and module globals between projections", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-isolation-"),
    );
    const mutator = await makePlugin({
      root: pluginsRoot,
      id: "alpha-mutator",
      handlers: {
        "main.mjs": `let calls = 0; export default ({ value }) => { calls++; value.summary = "mutated"; return { facts: { id: "mutator", kind: value.summary, calls } }; };`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
      schemaRequired: ["id", "kind"],
    });
    const observer = await makePlugin({
      root: pluginsRoot,
      id: "zeta-observer",
      handlers: {
        "main.mjs": `export default ({ value }) => ({ facts: { id: "observer", kind: value.summary } });`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
      schemaRequired: ["id", "kind"],
    });
    const sourceValue = structuredClone(VALID_WORLD_IR);
    const source = await makeSource(sourceValue);

    const first = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [source],
      now: NOW,
      deps: {
        activePlugins: ["zeta-observer", "alpha-mutator"],
        registry: registry([observer, mutator]),
      },
    });
    const second = await buildImportPlan({
      sessionId: "sess-2",
      worldId: "world-1",
      sources: [source],
      now: NOW,
      deps: {
        activePlugins: ["zeta-observer", "alpha-mutator"],
        registry: registry([observer, mutator]),
      },
    });

    for (const plan of [first, second]) {
      expect(
        plan.writes.map((write) =>
          write.kind === "plugin-data" ? write.value : undefined,
        ),
      ).toEqual([
        { id: "mutator", kind: "mutated", calls: 1 },
        { id: "observer", kind: VALID_WORLD_IR.summary },
      ]);
    }
    expect(sourceValue.summary).toBe(VALID_WORLD_IR.summary);
  });

  it("discards output when a handler changes during execution", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-handler-race-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "changing-handler",
      handlers: {
        "main.mjs": `import { writeFileSync } from "node:fs"; import { fileURLToPath } from "node:url"; export default () => { writeFileSync(fileURLToPath(import.meta.url), "export default () => ({ facts: { id: 'changed' } });\\n"); return { facts: { id: "stale" } }; };`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      deps: {
        activePlugins: ["changing-handler"],
        registry: registry([plugin]),
      },
    });

    expect(plan.writes).toEqual([]);
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warning",
          message: expect.stringContaining("changed during execution"),
        }),
      ]),
    );
  });

  it("bounds handler time, output bytes, and projected item count", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-limits-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "limited",
      handlers: {
        "hang.mjs": `export default async () => new Promise((resolve) => setTimeout(resolve, 5000));`,
        "bytes.mjs": `export default () => ({ facts: { id: "large", payload: "x".repeat(1100000) } });`,
        "forge.mjs": `import { parentPort } from "node:worker_threads"; parentPort.postMessage({ ok: true, json: "x".repeat(1100000) }); export default () => ({ facts: { id: "forged" } });`,
        "items.mjs": `export default () => ({ facts: Array.from({ length: 1001 }, (_, id) => ({ id })) });`,
      },
      projections: {
        hang: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/hang.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
        bytes: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/bytes.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
        forge: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/forge.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
        items: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/items.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      deps: {
        activePlugins: ["limited"],
        registry: registry([plugin]),
      },
    });

    expect(plan.writes).toEqual([]);
    const messages = plan.diagnostics.map((item) => item.message).join("\n");
    expect(messages).toContain("exceeds the configured output budget");
    expect(messages).toContain("invalid or oversized payload");
    expect(messages).toContain("timed out after 1000ms");
    expect(messages).toContain("has 1001 items; maximum is 1000");
    expect(plan.diagnostics.every((item) => item.level === "warning")).toBe(
      true,
    );
  });

  it("degrades duplicate projected keys without blocking canonical import", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-collision-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "colliding-facts",
      handlers: {
        "main.mjs": `export default () => ({ facts: [{ id: "same", kind: "first" }, { id: "same", kind: "second" }] });`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
      schemaRequired: ["id", "kind"],
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      deps: {
        activePlugins: ["colliding-facts"],
        registry: registry([plugin]),
      },
    });

    expect(plan.writes).toEqual([
      expect.objectContaining({
        pluginId: "colliding-facts",
        key: "same",
        value: expect.objectContaining({ kind: "first" }),
      }),
    ]);
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warning",
          message: expect.stringContaining("collision"),
        }),
      ]),
    );
    expect(plan.diagnostics.some((item) => item.level === "error")).toBe(false);
  });

  it("keeps canonical data over a cross-source projection in either source order", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-cross-source-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "facts",
      handlers: {
        "main.mjs": `export default () => ({ facts: { id: "same", kind: "projected" } });`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
      schemaRequired: ["id", "kind"],
    });
    const canonicalRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-canonical-source-"),
    );
    await writeFile(
      path.join(canonicalRoot, "facts.json"),
      JSON.stringify({ id: "same", kind: "canonical" }),
    );
    const canonical: OrderedWorldDataSource = {
      id: "canonical",
      descriptor: {
        kind: "json",
        path: "facts.json",
        to: "plugin:facts/facts",
        key: "id",
      },
      order: 0,
      origin: "world",
      overridden: false,
      pathOrigin: { descriptorRoot: canonicalRoot, origin: "world" },
      schemaOrigin: { descriptorRoot: canonicalRoot, origin: "world" },
      resolvedOrder: 0,
    };
    const projected = await makeSource(VALID_WORLD_IR);
    const deps = {
      activePlugins: ["facts"],
      registry: registry([plugin]),
    };

    for (const sources of [
      [canonical, projected],
      [projected, canonical],
    ]) {
      const plan = await buildImportPlan({
        sessionId: "sess-1",
        worldId: "world-1",
        sources,
        now: NOW,
        deps,
      });
      expect(plan.writes).toEqual([
        expect.objectContaining({
          pluginId: "facts",
          namespace: "facts",
          key: "same",
          value: { id: "same", kind: "canonical" },
        }),
      ]);
      expect(plan.diagnostics.some((item) => item.level === "error")).toBe(
        false,
      );
    }
  });

  it("still fans out when the source's primary target plugin is inactive", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-primary-inactive-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "facts",
      handlers: {
        "main.mjs": `export default () => ({ facts: { id: "fanout" } });`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
    });
    const baseSource = await makeSource(VALID_WORLD_IR);
    const source: OrderedWorldDataSource = {
      ...baseSource,
      descriptor: {
        ...baseSource.descriptor,
        to: "plugin:inactive/entries",
      },
    };

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [source],
      now: NOW,
      deps: {
        activePlugins: ["facts"],
        registry: registry([plugin]),
      },
    });

    expect(plan.writes).toEqual([
      expect.objectContaining({ pluginId: "facts", key: "fanout" }),
    ]);
    expect(plan.diagnostics.map((item) => item.message).join("\n")).toContain(
      "primary write",
    );
  });

  it("rejects a strict WorldIR schema violation before loading handlers", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-schema-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "facts",
      handlers: {
        "throw.mjs": `export default () => { throw new Error("must not run"); };`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/throw.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
    });
    const invalid = { ...VALID_WORLD_IR, unexpected: true };

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(invalid)],
      now: NOW,
      deps: {
        activePlugins: ["facts"],
        registry: registry([plugin]),
      },
    });

    expect(plan.writes).toEqual([]);
    expect(plan.diagnostics.map((item) => item.message).join("\n")).toContain(
      "invalid WorldIRV1",
    );
    expect(
      plan.diagnostics.map((item) => item.message).join("\n"),
    ).not.toContain("must not run");
  });

  it("reports an unsafe or missing handler as a projection diagnostic", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-handler-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "facts",
      handlers: {},
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "../outside.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      deps: {
        activePlugins: ["facts"],
        registry: registry([plugin]),
      },
    });

    expect(plan.writes).toEqual([]);
    expect(plan.diagnostics.map((item) => item.message).join("\n")).toContain(
      'world projection "facts/main" handler "../outside.mjs" is missing, invalid, or escapes the plugin root',
    );
  });

  it("reports missing keys and target dataSchema failures independently", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-output-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "facts",
      handlers: {
        "main.mjs": `export default () => ({ invalid: { id: "bad" }, missing: { kind: "fact" } });`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: {
            invalid: { namespace: "invalid", key: "id" },
            missing: { namespace: "missing", key: "id" },
          },
        },
      },
      namespaces: ["invalid", "missing"],
      schemaRequired: ["id", "kind"],
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      deps: {
        activePlugins: ["facts"],
        registry: registry([plugin]),
      },
    });

    expect(plan.writes).toEqual([]);
    const messages = plan.diagnostics.map((item) => item.message).join("\n");
    expect(messages).toContain('output "invalid" worldData value');
    expect(messages).toContain('output "missing" item 0 needs');
  });

  it("defers an entire output when any item is invalid", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-output-atomic-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "facts",
      handlers: {
        "main.mjs": `export default () => ({ facts: [{ id: "valid", kind: "fact" }, { id: "invalid" }] });`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
      schemaRequired: ["id", "kind"],
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      deps: {
        activePlugins: ["facts"],
        registry: registry([plugin]),
      },
    });

    expect(plan.writes).toEqual([]);
    expect(plan.deferredProjectionOutputs).toEqual([
      {
        sourceId: "world-ir",
        pluginId: "facts",
        projectionId: "main",
        outputId: "facts",
      },
    ]);
  });

  it("rejects missing and undeclared handler outputs", async () => {
    const pluginsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-shape-"),
    );
    const plugin = await makePlugin({
      root: pluginsRoot,
      id: "facts",
      handlers: {
        "main.mjs": `export default () => ({ extra: { id: "extra" } });`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      deps: {
        activePlugins: ["facts"],
        registry: registry([plugin]),
      },
    });

    const messages = plan.diagnostics.map((item) => item.message).join("\n");
    expect(messages).toContain('did not return declared output "facts"');
    expect(messages).toContain('returned undeclared output "extra"');
  });
});
