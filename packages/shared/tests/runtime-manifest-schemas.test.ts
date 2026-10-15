import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import {
  runtimeManifestInputSchema,
  worldProjectionMapSchema,
} from "../src/schemas/plugin.js";
import { runtimeAuthoringManifestSchema } from "../src/schemas/runtime-manifest.js";
import {
  AUTHOR_SCHEMA_NAMES,
  buildManifestJsonSchemas,
  schemaOutputPath,
} from "../scripts/generate-json-schemas.js";

// ── Ajv compiled from the committed JSON Schema artifact ─────────────
// The compiled RuntimeManifest is the loader's internal form. Fixtures are
// asserted against BOTH the Zod schema and the generated JSON Schema so the
// two stay in lockstep. Cross-field superRefine constraints and array
// uniqueness cannot cross into JSON Schema, so those fixtures are marked
// `zodOnly` and only asserted against Zod (the JSON Schema accepts them).

const ajv = new Ajv({ allErrors: true, strict: false });

const compiledValidator: ValidateFunction = ajv.compile(
  JSON.parse(readFileSync(schemaOutputPath("compiled"), "utf8")),
);

const base = { name: "sample-runtime", description: "A sample runtime." };

interface Fixture {
  readonly name: string;
  readonly manifest: Record<string, unknown>;
  /** Rejection is a cross-field / uniqueness constraint the JSON Schema omits. */
  readonly zodOnly?: boolean;
}

function assertAccepted({ manifest }: Fixture): void {
  expect(runtimeManifestInputSchema.safeParse(manifest).success).toBe(true);
  expect(compiledValidator(manifest)).toBe(true);
}

function assertRejected(fixture: Fixture): void {
  expect(runtimeManifestInputSchema.safeParse(fixture.manifest).success).toBe(
    false,
  );
  if (!fixture.zodOnly) {
    // Structural rejection — the generated JSON Schema must agree.
    expect(compiledValidator(fixture.manifest)).toBe(false);
  }
}

// ── Shared new-shape building blocks ────────────────────────────────

const newShapeFields = {
  stage: "post-turn",
  after: ["narrator", { capability: "narrative", cardinality: "one" }],
  needs: [{ runtime: "narrator", scope: "turn" }, { capability: "world-data" }],
  inputs: {
    prose: {
      from: { runtime: "narrator" },
      select: "/narrativeOutput",
      required: true,
      accepts: "./schemas/prose.json",
    },
  },
  effects: {
    reads: ["narrative:*", "plugin-data:self:codex"],
    writes: ["state:*", "event:codex.updated"],
    parallelSafe: false,
  },
  permissions: {
    http: [{ origin: "https://api.example.com", methods: ["GET", "POST"] }],
  },
  output: { recordAs: "codexEntries", schema: "./schemas/output.json" },
  input: {
    schema: "./schemas/activation.json",
    inject: [
      {
        kind: "runtime-export",
        name: "priorCodex",
        from: { capability: "narrative", cardinality: "one" },
        recordAs: "codexEntries",
        accepts: "./schemas/output.json",
        required: false,
      },
    ],
  },
} as const;

// ── Positives — shapes the compiler produces ────────────────────────

const compiledPositives: readonly Fixture[] = [
  {
    name: "required tool choice for explicit completion",
    manifest: {
      ...base,
      stage: "post-turn",
      llm: { reasoningEffort: "disabled", toolChoice: "required" },
    },
  },
  {
    name: "stage narrative + auto trigger (narrator)",
    manifest: { ...base, stage: "narrative", trigger: { type: "auto" } },
  },
  {
    name: "post-turn stage + capability needs",
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "auto", every: 1 },
      needs: [{ capability: "narrative-engine" }],
    },
  },
  {
    name: "event trigger + topic (no stage)",
    manifest: {
      ...base,
      trigger: { type: "event", topic: "scene.set" },
    },
  },
  {
    name: "manual + background execution",
    manifest: {
      ...base,
      trigger: { type: "manual" },
      execution: "background",
    },
  },
  {
    name: "post-turn detached turn completion",
    manifest: {
      ...base,
      stage: "post-turn",
      turnCompletion: {
        mode: "detached",
        settle: true,
        maxSettleWaitMs: 30_000,
        maxQueueMs: 30_000,
        maxExecutionMs: 90_000,
      },
    },
  },
  {
    name: "setup stage + auto trigger + maxTriggerCount",
    manifest: {
      ...base,
      stage: "setup",
      trigger: { type: "auto", maxTriggerCount: 1 },
    },
  },
];

const fullPositive: Fixture = {
  name: "every scheduling, io and policy field",
  manifest: {
    ...base,
    trigger: { type: "auto", every: 2 },
    ...newShapeFields,
  },
};

// The compiler parses the description as written (a locale map from an
// older locale file is accepted) and folds it to a string after parse.
const i18nDescriptionPositive: Fixture = {
  name: "I18nText description map",
  manifest: {
    ...base,
    description: { zh: "样例运行时。", en: "A sample runtime." },
    stage: "post-turn",
    trigger: { type: "auto" },
  },
};

// World projections are a package field (`contributes.worldProjections`).
const emptyWorldProjectionRejections: readonly Fixture[] = [
  {
    name: "empty worldProjections map",
    manifest: {
      ...base,
      stage: "post-turn",
      worldProjections: {},
    },
  },
  {
    name: "world projection without outputs",
    manifest: {
      ...base,
      stage: "post-turn",
      worldProjections: {
        facts: {
          from: "covel://world/ir/v1",
          handler: "server/project.js",
          outputs: {},
        },
      },
    },
  },
  {
    name: "world projection with whitespace-only source schema",
    manifest: {
      ...base,
      stage: "post-turn",
      worldProjections: {
        facts: {
          from: " ",
          handler: "server/project.js",
          outputs: {
            facts: { namespace: "facts", key: "id" },
          },
        },
      },
    },
  },
];

const caseInsensitiveProjectionPositive: Fixture = {
  name: "mixed-case namespace and JavaScript handler path",
  manifest: {
    ...base,
    stage: "post-turn",
    worldProjections: {
      facts: {
        from: "covel://world/ir/v1",
        handler: "Server/Project.JS",
        outputs: {
          facts: { namespace: "Facts", key: "id" },
        },
      },
    },
  },
};

// ── Rejections ──────────────────────────────────────────────────────

const structuralRejections: readonly Fixture[] = [
  {
    name: "priority (unknown field)",
    manifest: { ...base, stage: "narrative", priority: 500 },
  },
  {
    name: "upstreamRequired (unknown field)",
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "auto" },
      upstreamRequired: [{ capability: "narrative-engine" }],
    },
  },
  {
    name: "scheduled trigger (not in the enum)",
    manifest: { ...base, stage: "narrative", trigger: { type: "scheduled" } },
  },
  {
    name: "trigger interval (unknown field)",
    manifest: {
      ...base,
      stage: "narrative",
      trigger: { type: "auto", interval: 2 },
    },
  },
  {
    name: "plugin output kind (not in the enum)",
    manifest: { ...base, stage: "narrative", outputKind: "plugin" },
  },
  {
    name: "conditional trigger (not in the enum)",
    manifest: { ...base, stage: "narrative", trigger: { type: "conditional" } },
  },
  {
    name: "error-retry trigger (not in the enum)",
    manifest: { ...base, stage: "narrative", trigger: { type: "error-retry" } },
  },
  {
    name: "jobStatus.legacyViews (unknown field)",
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "auto" },
      jobStatus: { legacyViews: [{ namespace: "tracks" }] },
    },
  },
  {
    name: "{ runtime, cardinality } dependency entry",
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "auto" },
      needs: [{ runtime: "narrator", cardinality: "one" }],
    },
  },
  {
    name: "after entry carrying scope",
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "auto" },
      after: [{ runtime: "narrator", scope: "turn" }],
    },
  },
];

const crossFieldRejections: readonly Fixture[] = [
  {
    name: "empty i18n description map",
    zodOnly: true,
    manifest: {
      ...base,
      description: {},
      stage: "post-turn",
      trigger: { type: "auto" },
    },
  },
  {
    name: "function runtime without handler",
    zodOnly: true,
    manifest: { ...base, runtimeType: "function", stage: "pre-turn" },
  },
  {
    name: "event trigger without topic",
    zodOnly: true,
    manifest: { ...base, trigger: { type: "event" } },
  },
  {
    name: "needs scope 'session' on a non-setup stage",
    zodOnly: true,
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "auto" },
      needs: [{ runtime: "world-seed/setup", scope: "session" }],
    },
  },
  {
    name: "manual trigger with a stage",
    zodOnly: true,
    manifest: { ...base, stage: "post-turn", trigger: { type: "manual" } },
  },
  {
    name: "stage setup with every",
    zodOnly: true,
    manifest: {
      ...base,
      stage: "setup",
      trigger: { type: "auto", every: 2 },
    },
  },
  {
    name: "event trigger with every",
    zodOnly: true,
    manifest: {
      ...base,
      trigger: { type: "event", topic: "scene.set", every: 2 },
    },
  },
  {
    name: "output.recordAs without output.schema",
    zodOnly: true,
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "auto" },
      output: { recordAs: "codexEntries" },
    },
  },
  {
    name: "detached runtime in narrative stage",
    zodOnly: true,
    manifest: {
      ...base,
      stage: "narrative",
      turnCompletion: { mode: "detached" },
    },
  },
  {
    name: "detached runtime with story output",
    zodOnly: true,
    manifest: {
      ...base,
      stage: "post-turn",
      outputKind: "story",
      turnCompletion: { mode: "detached" },
    },
  },
  {
    name: "manual runtime using detached turn completion",
    zodOnly: true,
    manifest: {
      ...base,
      trigger: { type: "manual" },
      turnCompletion: { mode: "detached" },
    },
  },
  {
    name: "detached-only options with await mode",
    zodOnly: true,
    manifest: {
      ...base,
      stage: "post-turn",
      turnCompletion: { mode: "await", maxQueueMs: 30_000 },
    },
  },
  {
    name: "background manual runtime with the suspend tool",
    zodOnly: true,
    manifest: {
      ...base,
      trigger: { type: "manual" },
      execution: "background",
      tools: { builtin: ["suspend"] },
    },
  },
  {
    name: "detached runtime with the suspend tool",
    zodOnly: true,
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "auto" },
      turnCompletion: { mode: "detached" },
      tools: { builtin: ["suspend"] },
    },
  },
];

// ── Malformed rejections ────────────────────────────────────────────

const malformedRejections: readonly Fixture[] = [
  {
    name: "function runtime without handler",
    zodOnly: true,
    manifest: { ...base, runtimeType: "function", stage: "pre-turn" },
  },
  {
    name: "function runtime with a blank handler",
    zodOnly: true,
    manifest: {
      ...base,
      runtimeType: "function",
      handler: "   ",
      stage: "pre-turn",
    },
  },
  {
    name: "inputs.select with an illegal JSON Pointer",
    manifest: {
      ...base,
      stage: "narrative",
      inputs: {
        prose: { from: { runtime: "narrator" }, select: "narrativeOutput" },
      },
    },
  },
  {
    name: "permissions.http origin is not https",
    manifest: {
      ...base,
      stage: "narrative",
      permissions: { http: [{ origin: "http://api.example.com" }] },
    },
  },
  {
    name: "unknown top-level field",
    manifest: { ...base, stage: "narrative", bogusField: true },
  },
  {
    name: "turnCompletion maxQueueMs is not positive",
    manifest: {
      ...base,
      stage: "post-turn",
      turnCompletion: { mode: "detached", maxQueueMs: 0 },
    },
  },
  {
    name: "turnCompletion maxExecutionMs is not positive",
    manifest: {
      ...base,
      stage: "post-turn",
      turnCompletion: { mode: "detached", maxExecutionMs: 0 },
    },
  },
  {
    name: "turnCompletion maxSettleWaitMs exceeds the kernel ceiling",
    manifest: {
      ...base,
      stage: "post-turn",
      runtimeType: "function",
      handler: "./handler.js",
      turnCompletion: {
        mode: "detached",
        settle: true,
        maxSettleWaitMs: 120_001,
      },
    },
  },
  {
    name: "turnCompletion with the removed overlap policy",
    manifest: {
      ...base,
      stage: "post-turn",
      turnCompletion: { mode: "detached", overlap: "serial" },
    },
  },
  {
    name: "turnCompletion unknown field",
    manifest: {
      ...base,
      stage: "post-turn",
      turnCompletion: { mode: "detached", retry: true },
    },
  },
  {
    name: "detached runtime in setup stage",
    zodOnly: true,
    manifest: {
      ...base,
      stage: "setup",
      turnCompletion: { mode: "detached" },
    },
  },
  {
    name: "event runtime using detached turn completion",
    zodOnly: true,
    manifest: {
      ...base,
      trigger: { type: "event", topic: "scene.set" },
      turnCompletion: { mode: "detached" },
    },
  },
  {
    name: "reserved conditional trigger (rejected)",
    manifest: { ...base, stage: "narrative", trigger: { type: "conditional" } },
  },
  {
    name: "reserved error-retry trigger (rejected)",
    manifest: { ...base, stage: "narrative", trigger: { type: "error-retry" } },
  },
];

// ── Tests ───────────────────────────────────────────────────────────

describe("runtimeManifestInputSchema (compiled RuntimeManifest)", () => {
  for (const fixture of [
    ...compiledPositives,
    fullPositive,
    i18nDescriptionPositive,
  ])
    it(`accepts: ${fixture.name}`, () => {
      assertAccepted(fixture);
    });

  for (const fixture of [...structuralRejections, ...malformedRejections])
    it(`rejects: ${fixture.name}`, () => {
      assertRejected(fixture);
    });

  for (const fixture of crossFieldRejections)
    it(`rejects (Zod cross-field only): ${fixture.name}`, () => {
      assertRejected(fixture);
    });

  // Package-level fields live on the package declaration only; a compiled
  // runtime that carried them would always hold an empty copy.
  it.each([
    ["events", [{ topic: "scene.set", schema: "./e.json", description: "x" }]],
    ["ui", { right: ["./ui/panel.json"] }],
    ["tags", ["mode:dialogue"]],
    ["entry", "./server/index.js"],
    ["extensions", []],
    ["commands", []],
    ["displayName", "Sample"],
    ["worldProjections", {}],
    ["i18n", { zh: "x" }],
  ])("rejects the package-level field %s", (field, value) => {
    assertRejected({
      name: field,
      manifest: { ...base, stage: "post-turn", [field]: value },
    });
  });

  it("accepts the suspend tool on a manual runtime that runs in the foreground", () => {
    assertAccepted({
      name: "sync manual runtime with the suspend tool",
      manifest: {
        ...base,
        trigger: { type: "manual" },
        execution: "sync",
        tools: { builtin: ["suspend"] },
      },
    });
  });

  it("rejects an empty i18n description map (Zod refine only)", () => {
    assertRejected({
      name: "empty i18n description map",
      zodOnly: true,
      manifest: { ...base, stage: "post-turn", description: {} },
    });
  });

  it("rejects the in-code inject kind runtime", () => {
    assertRejected({
      name: "inject kind runtime",
      manifest: {
        ...base,
        stage: "post-turn",
        input: {
          inject: [
            { kind: "runtime", from: "narrator", field: "x", as: "<x>" },
          ],
        },
      },
    });
  });

  it("is not the authoring format", () => {
    const authored = {
      description: "A sample runtime.",
      schedule: { stage: "post-turn" },
    };
    expect(runtimeAuthoringManifestSchema.safeParse(authored).success).toBe(
      true,
    );
    expect(compiledValidator({ name: "sample", ...authored })).toBe(false);
    expect(buildManifestJsonSchemas().compiled.title).toMatch(
      /not an authoring format/,
    );
  });
});

describe("worldProjectionMapSchema", () => {
  it(`accepts ${caseInsensitiveProjectionPositive.name}`, () => {
    expect(
      worldProjectionMapSchema.safeParse(
        caseInsensitiveProjectionPositive.manifest.worldProjections,
      ).success,
    ).toBe(true);
  });

  for (const fixture of emptyWorldProjectionRejections)
    it(`rejects: ${fixture.name}`, () => {
      expect(
        worldProjectionMapSchema.safeParse(fixture.manifest.worldProjections)
          .success,
      ).toBe(false);
    });
});

type JsonNode = Record<string, unknown>;

function isNode(value: unknown): value is JsonNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Paths of every property in a JSON Schema that has no description. */
function undescribedProperties(root: JsonNode): string[] {
  const missing: string[] = [];
  const visited = new Set<JsonNode>();
  const definitions = isNode(root.definitions) ? root.definitions : {};
  function visit(node: unknown, path: string): void {
    if (!isNode(node)) return;
    if (typeof node.$ref === "string") {
      const target = definitions[node.$ref.split("/").pop() ?? ""];
      if (isNode(target) && !visited.has(target)) {
        visited.add(target);
        visit(target, path);
      }
      return;
    }
    for (const keyword of ["anyOf", "allOf", "oneOf"]) {
      const branches = node[keyword];
      if (Array.isArray(branches))
        for (const branch of branches) visit(branch, path);
    }
    if (isNode(node.properties)) {
      for (const [key, property] of Object.entries(node.properties)) {
        const propertyPath = path ? `${path}.${key}` : key;
        if (!isNode(property) || typeof property.description !== "string")
          missing.push(propertyPath);
        visit(property, propertyPath);
      }
    }
    visit(node.items, `${path}[]`);
    visit(node.additionalProperties, `${path}.*`);
  }
  visit(root, "");
  return missing;
}

describe("generated JSON Schema artifacts", () => {
  it("committed files are in sync with the generator (no drift)", () => {
    const generated = buildManifestJsonSchemas();
    for (const name of Object.keys(generated) as (keyof typeof generated)[]) {
      expect(
        JSON.parse(readFileSync(schemaOutputPath(name), "utf8")),
        `${name}: run \`pnpm --filter @covel/shared generate:schemas\``,
      ).toEqual(generated[name]);
    }
  });

  // The author-facing schemas feed editor hints and the generated reference
  // pages, so a field without a description is a field nobody can look up.
  for (const name of AUTHOR_SCHEMA_NAMES) {
    it(`every ${name} field carries a description`, () => {
      expect(undescribedProperties(buildManifestJsonSchemas()[name])).toEqual(
        [],
      );
    });
  }

  it("the compiled artifact compiles under Ajv v8 (draft-7)", () => {
    // ajv.compile throws on an invalid schema; reaching here is the assert.
    expect(typeof compiledValidator).toBe("function");
  });
});

it("runtime-case editor schema rejects misspelled expectations and missing runtime IDs", () => {
  const validate = new Ajv({ strict: false }).compile(
    JSON.parse(readFileSync(schemaOutputPath("runtimeCases"), "utf8")),
  );
  expect(
    validate({
      cases: [
        {
          name: "sample",
          runtimeId: "sample/main",
          expect: { runtimeResults: [{ status: "success" }] },
        },
      ],
    }),
  ).toBe(true);
  expect(
    validate({
      cases: [
        {
          name: "sample",
          runtimeId: "sample/main",
          expect: { runtimeResult: [] },
        },
      ],
    }),
  ).toBe(false);
  expect(validate([{ name: "sample" }])).toBe(false);
  expect(
    validate({
      cases: [
        {
          name: "sample",
          runtimeId: "sample/main",
          artifacts: { saveImages: { directory: "out" } },
        },
      ],
    }),
  ).toBe(false);
});

describe("the runtime type comes from the function block", () => {
  it("reads a runtime without a function block as an agent and one with it as a function", () => {
    const parse = (value: object) =>
      runtimeAuthoringManifestSchema.safeParse(value).success;
    expect(parse({ schedule: { stage: "post-turn" } })).toBe(true);
    expect(parse({ schedule: { stage: "post-turn" }, function: {} })).toBe(
      true,
    );
    expect(
      parse({
        schedule: { stage: "post-turn" },
        function: {},
        agent: { model: "utility" },
      }),
    ).toBe(false);
    // `type` is no longer a field.
    expect(parse({ type: "agent", schedule: { stage: "post-turn" } })).toBe(
      false,
    );
  });
});
