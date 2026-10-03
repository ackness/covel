/**
 * Generate JSON Schema (draft-7) for the author-facing Zod schemas using
 * Zod 4's built-in `z.toJSONSchema` — no `zod-to-json-schema` dependency.
 *
 * Artifacts are emitted into `packages/shared/schemas/` and committed:
 *   - `plugin-manifest.schema.json`            (root PLUGIN.md frontmatter)
 *   - `runtime-manifest.schema.json`           (RUNTIME.md / inline runtime)
 *   - `world-manifest.schema.json`             (world.yaml)
 *   - `world-data.schema.json`                 (world data descriptor)
 *   - `world-dimensions.schema.json`           (external dimension files)
 *   - `runtime-manifest.input.schema.json`     (compiled loader input)
 *   - `runtime-manifest.authoring.schema.json` (compiled strict target)
 *
 * The first five are what authors write. Their field descriptions come from
 * `.describe()` / `.meta()` on the Zod schemas, which makes those schemas the
 * single source for editor hints and for the generated reference pages under
 * `docs/reference/schema/`.
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
 * Object cardinality refinements that JSON Schema can express are restored by
 * `restoreRepresentableConstraints` below.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  runtimeManifestInputSchema,
  runtimeManifestAuthoringSchema,
} from "../src/schemas/plugin.js";

import { worldDimensionsSchema } from "../src/schemas/dimensions.js";
import { pluginManifestSchema } from "../src/schemas/plugin-manifest.js";
import { runtimeAuthoringManifestSchema } from "../src/schemas/runtime-manifest.js";
import { worldDataDescriptorSchema } from "../src/schemas/world-data.js";
import { worldManifestSchema } from "../src/schemas/world.js";

const TO_JSON_SCHEMA_OPTIONS = {
  target: "draft-7",
  io: "input",
  unrepresentable: "any",
} as const;

/** Constraints Zod enforces but JSON Schema draft-7 (via z.toJSONSchema) cannot. */
const SHARED_UNREPRESENTABLE_CONSTRAINTS = [
  "runtimeType 'function' requires a non-empty handler path.",
  "output.schema is required when output.recordAs is set.",
  "requireExplicitCompletion is only valid for non-story agent runtimes without output.schema.",
  "trigger.topic is required when trigger.type is 'event'.",
  "a runtime declaring `stage` cannot use trigger.type 'event' or 'manual'.",
  "stage 'setup' runtimes must use trigger.type 'auto' with no interval/startTurn/cooldownTurns.",
  "needs entries with scope 'session' are only valid on stage 'setup' runtimes.",
  "turnCompletion.mode 'detached' is only valid on post-turn/audit staged runtimes.",
  "turnCompletion.mode 'detached' cannot be used with outputKind 'story'.",
  "event/manual runtimes use execution and cannot use detached turn completion.",
  "turnCompletion queue/overlap/stale options require mode 'detached'.",
  "effects.reads, effects.writes and permissions.http[].methods must contain unique entries.",
  "an i18n description map must have at least one locale entry.",
] as const;

interface ManifestSchemaDoc {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly constraints: readonly string[];
}

const INPUT_DOC: ManifestSchemaDoc = {
  id: "https://covel.local/schemas/runtime-manifest.input.schema.json",
  title: "Covel runtime manifest (loader input)",
  summary:
    "What the plugin loader accepts — the field set that decides whether a PLUGIN.md parses at all. Same fields as the authoring schema, with fewer cross-field constraints enforced.",
  constraints: SHARED_UNREPRESENTABLE_CONSTRAINTS,
};

const AUTHORING_DOC: ManifestSchemaDoc = {
  id: "https://covel.local/schemas/runtime-manifest.authoring.schema.json",
  title: "Covel runtime manifest (strict authoring)",
  summary:
    "Strict target for newly authored plugins. Enforces every cross-field constraint, including a required stage on auto / scheduled runtimes.",
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
  restoreRepresentableConstraints(generated);
  const description =
    `${doc.summary}\n\nEnforced by Zod but not representable in this JSON Schema ` +
    `(validate with the Zod schema for these):\n` +
    doc.constraints.map((c) => `- ${c}`).join("\n");
  return { $id: doc.id, title: doc.title, description, ...generated };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Zod emits record refinements as plain objects, even where draft-7 has an
 * exact equivalent. Keep editor/Agent validation aligned with the loader for
 * those representable constraints instead of documenting a false superset.
 */
function restoreRepresentableConstraints(
  schema: Record<string, unknown>,
): void {
  const properties = asRecord(schema.properties);
  const worldProjections = asRecord(properties?.worldProjections);
  if (!worldProjections) return;
  worldProjections.minProperties = 1;

  const projection = asRecord(worldProjections.additionalProperties);
  const projectionProperties = asRecord(projection?.properties);
  const outputs = asRecord(projectionProperties?.outputs);
  if (outputs) outputs.minProperties = 1;
}

/**
 * The files an author writes. Every property in these schemas must carry a
 * description; the drift test enforces it.
 */
const AUTHOR_SCHEMAS = {
  plugin: {
    schema: pluginManifestSchema,
    file: "plugin-manifest.schema.json",
    title: "Plugin manifest",
    summary: "Frontmatter of a package's root `PLUGIN.md`.",
  },
  runtime: {
    schema: runtimeAuthoringManifestSchema,
    file: "runtime-manifest.schema.json",
    title: "Runtime manifest",
    summary:
      "Frontmatter of `runtimes/<id>/RUNTIME.md`, and the inline `runtime` of a root `PLUGIN.md`.",
  },
  world: {
    schema: worldManifestSchema,
    file: "world-manifest.schema.json",
    title: "World manifest",
    summary: "The `world.yaml` at the root of a world package.",
  },
  worldData: {
    schema: worldDataDescriptorSchema,
    file: "world-data.schema.json",
    title: "World data descriptor",
    summary:
      "The descriptor a world names in `worldData`, usually `data/world.data.yaml`.",
  },
  worldDimensions: {
    schema: worldDimensionsSchema,
    file: "world-dimensions.schema.json",
    title: "World dimensions",
    summary:
      "A file of dimension definitions keyed by dimension ID, usually `data/dimensions.yaml`.",
  },
} as const satisfies Record<
  string,
  {
    readonly schema: z.ZodType;
    readonly file: string;
    readonly title: string;
    readonly summary: string;
  }
>;

export type AuthorSchemaName = keyof typeof AUTHOR_SCHEMAS;
export type SchemaArtifactName = AuthorSchemaName | "input" | "authoring";

export const AUTHOR_SCHEMA_NAMES = Object.keys(
  AUTHOR_SCHEMAS,
) as readonly AuthorSchemaName[];

function toAuthorJsonSchema(name: AuthorSchemaName): Record<string, unknown> {
  const { schema, file, title, summary } = AUTHOR_SCHEMAS[name];
  const generated = z.toJSONSchema(schema, TO_JSON_SCHEMA_OPTIONS) as Record<
    string,
    unknown
  >;
  restoreRepresentableConstraints(generated);
  return {
    $id: `https://covel.local/schemas/${file}`,
    title: `Covel ${title.toLowerCase()}`,
    description: summary,
    ...generated,
  };
}

export function buildManifestJsonSchemas(): Record<
  SchemaArtifactName,
  Record<string, unknown>
> {
  return {
    plugin: toAuthorJsonSchema("plugin"),
    runtime: toAuthorJsonSchema("runtime"),
    world: toAuthorJsonSchema("world"),
    worldData: toAuthorJsonSchema("worldData"),
    worldDimensions: toAuthorJsonSchema("worldDimensions"),
    input: toDocumentedJsonSchema(runtimeManifestInputSchema, INPUT_DOC),
    authoring: toDocumentedJsonSchema(
      runtimeManifestAuthoringSchema,
      AUTHORING_DOC,
    ),
  };
}

/** Path of a committed schema artifact, relative to this script. */
export function schemaOutputPath(name: SchemaArtifactName): string {
  const file =
    name === "input" || name === "authoring"
      ? `runtime-manifest.${name}.schema.json`
      : AUTHOR_SCHEMAS[name].file;
  return fileURLToPath(new URL(`../schemas/${file}`, import.meta.url));
}

function main(): void {
  const schemas = buildManifestJsonSchemas();
  for (const name of Object.keys(schemas) as SchemaArtifactName[]) {
    writeFileSync(
      schemaOutputPath(name),
      `${JSON.stringify(schemas[name], null, 2)}\n`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `[generate:schemas] wrote ${Object.keys(schemas).length} schema files`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
