import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import {
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionRecordSchema,
  dimensionSettlementReceiptSchema,
  dimensionUpdatePayloadSchema,
  materializeDimensionRecords,
} from "@covel/shared";

// Path segments that would reach an object's prototype instead of its data.
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Set `value` at a dot path inside a copy of `base`, creating containers. */
function setAtPath(base, path, value) {
  const segments = path.split(".").filter(Boolean);
  if (!segments.length) return structuredClone(value);
  // The path comes from model output: never let it walk into a prototype.
  if (segments.some((segment) => UNSAFE_SEGMENTS.has(segment)))
    throw new Error(`Unsafe change path: ${path}`);
  const root = base && typeof base === "object" ? structuredClone(base) : {};
  let node = root;
  for (const [index, segment] of segments.entries()) {
    const key = Array.isArray(node) ? Number(segment) : segment;
    if (index === segments.length - 1) {
      node[key] = structuredClone(value);
      break;
    }
    if (
      !Object.hasOwn(node, key) ||
      !node[key] ||
      typeof node[key] !== "object"
    )
      node[key] = /^\d+$/.test(segments[index + 1]) ? [] : {};
    node = node[key];
  }
  return root;
}

/**
 * Resolve each update to a complete value. `changes` patch the frozen value
 * by path so a large dimension does not have to be rewritten in full. An
 * entry with neither a value nor any change says the dimension did not
 * change; it is dropped rather than sent back for another model call.
 */
function resolveUpdates(updates, dimensions) {
  const changed = updates.filter(
    (update) => Object.hasOwn(update, "value") || update.changes?.length,
  );
  return changed.map(({ changes, ...update }) => {
    if (!changes?.length) return update;
    if (Object.hasOwn(update, "value"))
      throw new Error(
        `${update.id}: provide either value or changes, not both`,
      );
    const current = dimensions[update.id];
    if (!current) throw new Error(`Unknown dimension: ${update.id}`);
    return {
      ...update,
      value: changes.reduce(
        (value, change) => setAtPath(value, change.path, change.value),
        current.value,
      ),
    };
  });
}

/** The model supplies values, never the authoritative source or read set. */
export default function ({ tool, z }) {
  return tool({
    name: "update-dimensions",
    description:
      'Settle this narrative\'s dimension rules once. Submit a batch of {id, expectedVersion, changes | value, reason}. Prefer changes: [{path, value}] to set only the fields or entries that changed (dot path inside the dimension value, e.g. "torn-letter.status"; a new key adds an entry); use value only to replace the whole value. Submit updates: [] to explicitly settle no change. Results must match the declared schema. Never invent facts or copy character/inventory/time state.',
    parameters: z.strictObject({
      updates: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            expectedVersion: z.number().int().positive(),
            value: z.unknown().optional(),
            changes: z
              .array(
                z.strictObject({
                  path: z.string().min(1),
                  value: z.unknown(),
                }),
              )
              .max(32)
              .optional(),
            reason: z.string().max(2000).optional(),
          }),
        )
        .max(64),
    }),
    execute: async (params, ctx) => {
      const updates = resolveUpdates(params.updates, ctx.world.dimensions);
      const narrative = ctx.inputSlots?.narrative;
      if (
        narrative?.cardinality !== "one" ||
        typeof narrative.value !== "string"
      )
        throw new Error(
          "A successful authoritative narrative input is required",
        );
      const rows = await ctx.store.listPluginData(DIMENSION_DATA_NAMESPACE);
      const records = Object.fromEntries(
        rows.map((row) => [row.key, dimensionRecordSchema.parse(row.value)]),
      );
      const row = await ctx.store.getPluginData(
        DIMENSION_SETTLEMENT_NAMESPACE,
        narrative.source.resultId,
      );
      const receipt = row
        ? dimensionSettlementReceiptSchema.parse(row.value)
        : undefined;
      if (receipt && receipt.status !== "pending-settlement")
        return { success: true, alreadySettled: true };
      const session = await ctx.store.getSession();
      const source = receipt?.source ?? {
        resultId: narrative.source.resultId,
        turnNumber: session.completedPlayerTurns + 1,
      };
      const readVersions = Object.fromEntries(
        Object.entries(ctx.world.dimensions).map(([id, entry]) => [
          id,
          entry.version,
        ]),
      );
      const payload = dimensionUpdatePayloadSchema.parse({
        updates,
        source,
        readVersions,
        ...(updates.length === 0 ? { settlement: "no-change" } : {}),
      });
      const proposal = makeProposal(
        ctx,
        new Date().toISOString(),
        "dimension.update",
        payload,
      );
      materializeDimensionRecords(records, proposal);
      return withPendingProposals(
        { success: true, updateCount: updates.length },
        [proposal],
      );
    },
  });
}
