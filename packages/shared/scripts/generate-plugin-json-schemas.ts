/**
 * Generate JSON Schema (draft-7) for the two runtime-manifest Zod schemas using
 * Zod 4's built-in `z.toJSONSchema` — no `zod-to-json-schema` dependency.
 *
 * Two artifacts are emitted into `packages/shared/schemas/` and committed:
 *   - `runtime-manifest.input.schema.json`     (compat superset)
 *   - `runtime-manifest.authoring.schema.json` (strict authoring target)
 *
 * The generator is exported (`buildManifestJsonSchemas`) so the drift test can
 * regenerate in-memory and compare against the committed files. Running this
 * file directly (`pnpm --filter @covel/shared generate:schemas`) writes them.
 *
 * `io: "input"` selects the author-facing (pre-transform, defaults-optional)
 * shape; `unrepresentable: "any"` lets constructs JSON Schema cannot express
 * (z.unknown, transforms) degrade to `{}` instead of throwing. Cross-field
 * superRefine constraints and array uniqueness are dropped by the generator —
 * they are recorded in each schema's `description` and enforced only by Zod.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  runtimeManifestInputSchema,
  runtimeManifestAuthoringSchema,
} from "../src/schemas/plugin.js";

const TO_JSON_SCHEMA_OPTIONS = {
  target: "draft-7",
  io: "input",
  unrepresentable: "any",
} as const;

/** Constraints Zod enforces but JSON Schema draft-7 (via z.toJSONSchema) cannot. */
const SHARED_UNREPRESENTABLE_CONSTRAINTS = [
  "output.schema is required when output.recordAs is set.",
  "trigger.topic is required when trigger.type is 'event'.",
  "a runtime declaring `stage` cannot use trigger.type 'event' or 'manual'.",
  "stage 'setup' runtimes must use trigger.type 'auto' with no interval/startTurn/cooldownTurns.",
  "effects.reads, effects.writes and permissions.http[].methods must contain unique entries.",
] as const;

interface ManifestSchemaDoc {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly constraints: readonly string[];
}

const INPUT_DOC: ManifestSchemaDoc = {
  id: "https://covel.local/schemas/runtime-manifest.input.schema.json",
  title: "Covel runtime manifest (compat input)",
  summary:
    "Backward-compatible superset accepted by the plugin loader. Retains legacy priority / upstreamRequired / jobStatus and the reserved trigger types.",
  constraints: SHARED_UNREPRESENTABLE_CONSTRAINTS,
};

const AUTHORING_DOC: ManifestSchemaDoc = {
  id: "https://covel.local/schemas/runtime-manifest.authoring.schema.json",
  title: "Covel runtime manifest (strict authoring)",
  summary:
    "Strict target for newly authored plugins. Rejects priority / upstreamRequired / jobStatus and the reserved trigger types.",
  constraints: [
    ...SHARED_UNREPRESENTABLE_CONSTRAINTS,
    "auto / scheduled runtimes must declare a stage.",
  ],
};

function toDocumentedJsonSchema(
  schema: z.ZodType,
  doc: ManifestSchemaDoc,
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, TO_JSON_SCHEMA_OPTIONS) as Record<
    string,
    unknown
  >;
  const description =
    `${doc.summary}\n\nEnforced by Zod but not representable in this JSON Schema ` +
    `(validate with the Zod schema for these):\n` +
    doc.constraints.map((c) => `- ${c}`).join("\n");
  return { $id: doc.id, title: doc.title, description, ...generated };
}

export function buildManifestJsonSchemas(): {
  readonly input: Record<string, unknown>;
  readonly authoring: Record<string, unknown>;
} {
  return {
    input: toDocumentedJsonSchema(runtimeManifestInputSchema, INPUT_DOC),
    authoring: toDocumentedJsonSchema(
      runtimeManifestAuthoringSchema,
      AUTHORING_DOC,
    ),
  };
}

/** Path of a committed schema artifact, relative to this script. */
export function schemaOutputPath(name: "input" | "authoring"): string {
  return fileURLToPath(
    new URL(`../schemas/runtime-manifest.${name}.schema.json`, import.meta.url),
  );
}

function main(): void {
  const { input, authoring } = buildManifestJsonSchemas();
  writeFileSync(
    schemaOutputPath("input"),
    `${JSON.stringify(input, null, 2)}\n`,
  );
  writeFileSync(
    schemaOutputPath("authoring"),
    `${JSON.stringify(authoring, null, 2)}\n`,
  );
  // eslint-disable-next-line no-console
  console.log(
    "[generate:schemas] wrote runtime-manifest.{input,authoring}.schema.json",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
