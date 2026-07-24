import { readFileSync } from "node:fs";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import {
  runtimeManifestInputSchema,
  runtimeManifestAuthoringSchema,
} from "../src/schemas/plugin.js";
import {
  buildManifestJsonSchemas,
  schemaOutputPath,
} from "../scripts/generate-plugin-json-schemas.js";

// ── Ajv compiled from the committed JSON Schema artifacts ────────────
// Fixtures are asserted against BOTH the Zod schema and the generated JSON
// Schema so the two stay in lockstep. Cross-field superRefine constraints and
// array uniqueness cannot cross into JSON Schema, so those fixtures are marked
// `zodOnly` and only asserted against Zod (the JSON Schema accepts them).

const ajv = new Ajv({ allErrors: true, strict: false });

function compileCommitted(name: "input" | "authoring"): ValidateFunction {
  const schema = JSON.parse(readFileSync(schemaOutputPath(name), "utf8"));
  return ajv.compile(schema);
}

const validators = {
  input: compileCommitted("input"),
  authoring: compileCommitted("authoring"),
};

const base = { name: "sample-runtime", description: "A sample runtime." };

interface Fixture {
  readonly name: string;
  readonly manifest: Record<string, unknown>;
  /** Rejection is a cross-field / uniqueness constraint the JSON Schema omits. */
  readonly zodOnly?: boolean;
}

function assertAccepted(
  target: "input" | "authoring",
  { manifest }: Fixture,
): void {
  const zodSchema =
    target === "input"
      ? runtimeManifestInputSchema
      : runtimeManifestAuthoringSchema;
  expect(zodSchema.safeParse(manifest).success).toBe(true);
  expect(validators[target](manifest)).toBe(true);
}

function assertRejected(target: "input" | "authoring", fixture: Fixture): void {
  const zodSchema =
    target === "input"
      ? runtimeManifestInputSchema
      : runtimeManifestAuthoringSchema;
  expect(zodSchema.safeParse(fixture.manifest).success).toBe(false);
  if (!fixture.zodOnly) {
    // Structural rejection — the generated JSON Schema must agree.
    expect(validators[target](fixture.manifest)).toBe(false);
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
  resultFormat: "envelope-v1",
  suspensionSafe: true,
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

// ── Compat (input) positives — current shipping shapes ──────────────

const compatCurrentPositives: readonly Fixture[] = [
  {
    name: "priority 500 + auto trigger (narrator)",
    manifest: { ...base, priority: 500, trigger: { type: "auto" } },
  },
  {
    name: "priority 600 + upstreamRequired capability",
    manifest: {
      ...base,
      priority: 600,
      trigger: { type: "scheduled", interval: 1 },
      upstreamRequired: [{ capability: "narrative-engine" }],
    },
  },
  {
    name: "event trigger + topic + priority",
    manifest: {
      ...base,
      priority: 460,
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
    name: "scheduled interval + maxTriggerCount",
    manifest: {
      ...base,
      priority: 40,
      trigger: { type: "scheduled", interval: 1, maxTriggerCount: 1 },
    },
  },
];

const compatNewPositive: Fixture = {
  name: "full new-shape manifest (compat superset)",
  manifest: {
    ...base,
    priority: 700,
    trigger: { type: "scheduled", interval: 1 },
    jobStatus: {
      legacyViews: [
        { namespace: "tracks", keyFrom: "/jobId", valueFrom: "/data" },
      ],
    },
    ...newShapeFields,
  },
};

// ── Authoring positive — pure new shape ─────────────────────────────

const authoringPositive: Fixture = {
  name: "pure new-shape manifest (strict authoring)",
  manifest: {
    ...base,
    trigger: { type: "scheduled", interval: 1 },
    ...newShapeFields,
  },
};

// The bundled plugins declare `description` as an I18nText map (preferred);
// the schema must accept it so editor tooling doesn't flag every manifest.
// The loader still folds it to a single string after parse.
const authoringI18nDescriptionPositive: Fixture = {
  name: "I18nText description map",
  manifest: {
    ...base,
    description: { zh: "样例运行时。", en: "A sample runtime." },
    stage: "post-turn",
    trigger: { type: "auto" },
  },
};

// ── Authoring rejections ────────────────────────────────────────────

const authoringStructuralRejections: readonly Fixture[] = [
  {
    name: "priority (legacy field)",
    manifest: { ...base, stage: "narrative", priority: 500 },
  },
  {
    name: "upstreamRequired (legacy field)",
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "scheduled", interval: 1 },
      upstreamRequired: [{ capability: "narrative-engine" }],
    },
  },
  {
    name: "conditional trigger (reserved)",
    manifest: { ...base, stage: "narrative", trigger: { type: "conditional" } },
  },
  {
    name: "error-retry trigger (reserved)",
    manifest: { ...base, stage: "narrative", trigger: { type: "error-retry" } },
  },
  {
    name: "jobStatus.legacyViews (compat-only)",
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "scheduled", interval: 1 },
      jobStatus: { legacyViews: [{ namespace: "tracks" }] },
    },
  },
  {
    name: "{ runtime, cardinality } dependency entry",
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "scheduled", interval: 1 },
      needs: [{ runtime: "narrator", cardinality: "one" }],
    },
  },
  {
    name: "after entry carrying scope",
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "scheduled", interval: 1 },
      after: [{ runtime: "narrator", scope: "turn" }],
    },
  },
];

const authoringCrossFieldRejections: readonly Fixture[] = [
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
    name: "stage setup with interval",
    zodOnly: true,
    manifest: {
      ...base,
      stage: "setup",
      trigger: { type: "auto", interval: 2 },
    },
  },
  {
    name: "auto trigger without stage",
    zodOnly: true,
    manifest: { ...base, trigger: { type: "auto" } },
  },
  {
    name: "output.recordAs without output.schema",
    zodOnly: true,
    manifest: {
      ...base,
      stage: "post-turn",
      trigger: { type: "scheduled", interval: 1 },
      output: { recordAs: "codexEntries" },
    },
  },
];

// ── Compat (input) malformed rejections ─────────────────────────────

const compatMalformedRejections: readonly Fixture[] = [
  {
    name: "inputs.select with an illegal JSON Pointer",
    manifest: {
      ...base,
      priority: 500,
      inputs: {
        prose: { from: { runtime: "narrator" }, select: "narrativeOutput" },
      },
    },
  },
  {
    name: "permissions.http origin is not https",
    manifest: {
      ...base,
      priority: 500,
      permissions: { http: [{ origin: "http://api.example.com" }] },
    },
  },
  {
    name: "unknown top-level field",
    manifest: { ...base, priority: 500, bogusField: true },
  },
  {
    // Step 6: reserved triggers are now rejected by the compat input schema too
    // (the enum narrowed to the four production types).
    name: "reserved conditional trigger (rejected)",
    manifest: { ...base, priority: 500, trigger: { type: "conditional" } },
  },
  {
    name: "reserved error-retry trigger (rejected)",
    manifest: { ...base, priority: 500, trigger: { type: "error-retry" } },
  },
];

// ── Tests ───────────────────────────────────────────────────────────

describe("runtimeManifestInputSchema (compat superset)", () => {
  for (const fixture of compatCurrentPositives) {
    it(`accepts current shape: ${fixture.name}`, () => {
      assertAccepted("input", fixture);
    });
  }

  it(`accepts ${compatNewPositive.name}`, () => {
    assertAccepted("input", compatNewPositive);
  });

  for (const fixture of compatMalformedRejections) {
    it(`rejects malformed: ${fixture.name}`, () => {
      assertRejected("input", fixture);
    });
  }
});

describe("runtimeManifestAuthoringSchema (strict authoring)", () => {
  it(`accepts ${authoringPositive.name}`, () => {
    assertAccepted("authoring", authoringPositive);
  });

  it(`accepts ${authoringI18nDescriptionPositive.name}`, () => {
    assertAccepted("authoring", authoringI18nDescriptionPositive);
  });

  it("rejects an empty i18n description map (Zod refine only)", () => {
    assertRejected("authoring", {
      name: "empty i18n description map",
      zodOnly: true,
      manifest: {
        ...base,
        description: {},
        stage: "post-turn",
        trigger: { type: "auto" },
      },
    });
  });

  for (const fixture of authoringStructuralRejections) {
    it(`rejects (structural, JSON Schema agrees): ${fixture.name}`, () => {
      assertRejected("authoring", fixture);
    });
  }

  for (const fixture of authoringCrossFieldRejections) {
    it(`rejects (Zod cross-field only): ${fixture.name}`, () => {
      assertRejected("authoring", fixture);
    });
  }
});

describe("generated JSON Schema artifacts", () => {
  it("committed files are in sync with the generator (no drift)", () => {
    const generated = buildManifestJsonSchemas();
    expect(JSON.parse(readFileSync(schemaOutputPath("input"), "utf8"))).toEqual(
      generated.input,
    );
    expect(
      JSON.parse(readFileSync(schemaOutputPath("authoring"), "utf8")),
    ).toEqual(generated.authoring);
  });

  it("both artifacts compile under Ajv v8 (draft-7)", () => {
    // compileCommitted throws on an invalid schema; reaching here is the assert.
    expect(typeof validators.input).toBe("function");
    expect(typeof validators.authoring).toBe("function");
  });
});
