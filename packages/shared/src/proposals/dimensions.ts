import { z } from "zod";
import {
  DIMENSION_MAX_UPDATES,
  dimensionIdSchema,
  dimensionJsonSchema,
  dimensionRecordSchema,
  dimensionSourceSchema,
  validateDimensionValue,
  worldDimensionsSchema,
} from "../schemas/dimensions.js";
import type {
  DimensionRecord,
  DimensionUpdatePayload,
} from "../types/dimensions.js";
import type { ProposalFor } from "../types/proposal.js";

export const dimensionInitializePayloadSchema = z.strictObject({
  definitions: worldDimensionsSchema,
});
export const dimensionUpdatePayloadSchema: z.ZodType<DimensionUpdatePayload> = z
  .strictObject({
    updates: z
      .array(
        z.strictObject({
          id: dimensionIdSchema,
          expectedVersion: z.number().int().positive(),
          value: dimensionJsonSchema,
          reason: z.string().max(2000).optional(),
        }),
      )
      .max(DIMENSION_MAX_UPDATES)
      .refine(
        (updates) =>
          new Set(updates.map((update) => update.id)).size === updates.length,
        { message: "Duplicate dimension update ID" },
      ),
    source: dimensionSourceSchema.optional(),
    readVersions: z
      .record(dimensionIdSchema, z.number().int().positive())
      .optional(),
    settlement: z.enum(["no-change", "manual", "skipped"]).optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.source && !payload.readVersions)
      ctx.addIssue({
        code: "custom",
        path: ["readVersions"],
        message: "Settlement requires read versions",
      });
    if (payload.updates.length === 0 && !(payload.source && payload.settlement))
      ctx.addIssue({
        code: "custom",
        path: ["updates"],
        message: "Empty updates require an explicit settlement",
      });
    if (payload.settlement && !payload.source)
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "Settlement requires a source",
      });
    if (
      (payload.settlement === "no-change" ||
        payload.settlement === "skipped") &&
      payload.updates.length > 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["updates"],
        message: "No-change/skip cannot change values",
      });
  });

export class DimensionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DimensionConflictError";
  }
}

export class DimensionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DimensionValidationError";
  }
}

export function dimensionsJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const a = Object.keys(left);
  const b = Object.keys(right);
  return (
    a.length === b.length &&
    a.every(
      (key) =>
        Object.hasOwn(right, key) &&
        dimensionsJsonEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

/** Shared domain materialization for tool previews and the commit boundary. */
export function materializeDimensionRecords(
  base: Readonly<Record<string, DimensionRecord>>,
  proposal: ProposalFor<"dimension.initialize" | "dimension.update">,
): Readonly<Record<string, DimensionRecord>> {
  const records: Record<string, DimensionRecord> = structuredClone(base);
  if (proposal.type === "dimension.initialize") {
    const { definitions } = dimensionInitializePayloadSchema.parse(
      proposal.payload,
    );
    for (const [id, definition] of Object.entries(definitions)) {
      const existing = records[id];
      if (existing && !dimensionsJsonEqual(existing.definition, definition))
        throw new DimensionConflictError(`Dimension definition changed: ${id}`);
      if (!existing)
        records[id] = {
          definition,
          value: structuredClone(definition.initialValue),
          version: 1,
        };
    }
    return records;
  }
  const payload = dimensionUpdatePayloadSchema.parse(proposal.payload);
  for (const [id, version] of Object.entries(payload.readVersions ?? {})) {
    if (records[id]?.version !== version)
      throw new DimensionConflictError(
        `Dimension read version conflict: ${id}`,
      );
  }
  for (const update of payload.updates) {
    const existing = records[update.id];
    if (!existing)
      throw new DimensionValidationError(`Unknown dimension: ${update.id}`);
    if (existing.version !== update.expectedVersion)
      throw new DimensionConflictError(
        `Dimension version conflict: ${update.id}`,
      );
    if (
      payload.source &&
      existing.lastTrackedSource &&
      payload.source.turnNumber < existing.lastTrackedSource.turnNumber
    )
      throw new DimensionConflictError(`Stale dimension source: ${update.id}`);
    const issues = validateDimensionValue(
      existing.definition.schema,
      update.value,
    );
    if (issues.length)
      throw new DimensionValidationError(
        `Invalid dimension ${update.id}: ${issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      );
    records[update.id] = dimensionRecordSchema.parse({
      ...existing,
      value: structuredClone(update.value),
      version:
        existing.version +
        (dimensionsJsonEqual(existing.value, update.value) ? 0 : 1),
      ...(payload.source ? { lastTrackedSource: payload.source } : {}),
    });
  }
  return records;
}
