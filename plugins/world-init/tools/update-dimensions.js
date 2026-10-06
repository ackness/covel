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

/**
 * The segments of a change path. It is a dot path; a model also writes it
 * with slashes ("call-0614/status"), so a slash separates too, unless the
 * value has a key that contains that slash.
 */
function pathSegments(base, path) {
  const segments = [];
  let node = base;
  for (const part of path.split(".").filter(Boolean)) {
    const isKey =
      node !== null && typeof node === "object" && Object.hasOwn(node, part);
    for (const segment of isKey ? [part] : part.split("/").filter(Boolean)) {
      segments.push(segment);
      node =
        node !== null &&
        typeof node === "object" &&
        Object.hasOwn(node, segment)
          ? node[segment]
          : undefined;
    }
  }
  return segments;
}

/** Set `value` at a path inside a copy of `base`, creating containers. */
function setAtPath(base, path, value) {
  const segments = pathSegments(base, path);
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

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Put a call into the declared shape where its meaning is not in doubt.
 * In real-model runs a `reason` was written on a change or beside `updates`,
 * one dimension was split over two entries, an entry without a change
 * carried an empty `updates` list of its own, and the version was left out
 * or copied. Each cost a rejected call and one more model call, and none of
 * them changes what is written.
 *
 * The version of an update is not the model's to give: the tool reads it
 * from the values this execution was shown (see `resolveUpdates`). A model
 * that sees its earlier calls still writes `expectedVersion`; it is left out
 * here.
 */
function normalizeArguments(input) {
  if (!isRecord(input) || !Array.isArray(input.updates)) return input;
  const { reason: _reason, ...call } = input;
  const updates = [];
  for (const entry of call.updates) {
    if (!isRecord(entry)) {
      updates.push(entry);
      continue;
    }
    const { expectedVersion: _version, ...written } = entry;
    if (Array.isArray(written.updates) && !written.updates.length)
      delete written.updates;
    const patched = Array.isArray(written.changes)
      ? {
          ...written,
          changes: written.changes.map((change) => {
            if (!isRecord(change)) return change;
            const { reason: _changeReason, ...rest } = change;
            return rest;
          }),
        }
      : written;
    // One change at the empty path is the whole value: a model writes it for
    // a dimension that is a number or a text, which has no path inside it.
    const [only] = patched.changes ?? [];
    const whole =
      patched.changes?.length === 1 &&
      isRecord(only) &&
      only.path === "" &&
      !Object.hasOwn(patched, "value");
    const { changes: _changes, ...unpatched } = patched;
    const update = whole ? { ...unpatched, value: only.value } : patched;
    const earlier = updates.find(
      (other) => isRecord(other) && other.id === update.id,
    );
    // Two entries that patch one dimension are one update. An entry that
    // replaces the whole value stays apart and is refused as a duplicate.
    if (
      !earlier ||
      Object.hasOwn(earlier, "value") ||
      Object.hasOwn(update, "value")
    ) {
      updates.push(update);
      continue;
    }
    earlier.changes = [...(earlier.changes ?? []), ...(update.changes ?? [])];
    const reasons = [earlier.reason, update.reason].filter(
      (reason) => typeof reason === "string" && reason,
    );
    if (reasons.length) earlier.reason = reasons.join(" ");
  }
  return { ...call, updates };
}

/**
 * Say what an unknown dimension ID is. The model takes an entry of a
 * dimension (a room of a map, a line of a log) for a dimension of its own.
 */
function unknownDimension(id, dimensions) {
  const owners = Object.keys(dimensions).filter(
    (owner) =>
      isRecord(dimensions[owner].value) &&
      Object.hasOwn(dimensions[owner].value, id),
  );
  return owners.length === 1
    ? `Unknown dimension: ${id}. It is an entry of the dimension ${owners[0]}: use id "${owners[0]}" and start each path with "${id}."`
    : `Unknown dimension: ${id}. The dimensions are: ${Object.keys(dimensions).join(", ")}`;
}

/**
 * Resolve each update to a complete value at the version this execution
 * read. `changes` patch the frozen value by path so a large dimension does
 * not have to be rewritten in full. An entry with neither a value nor any
 * change says the dimension did not change; it is dropped rather than sent
 * back for another model call.
 */
function resolveUpdates(updates, dimensions) {
  const changed = updates.filter(
    (update) => Object.hasOwn(update, "value") || update.changes?.length,
  );
  return changed.map(({ changes, ...update }) => {
    const current = dimensions[update.id];
    if (!current) throw new Error(unknownDimension(update.id, dimensions));
    const versioned = { ...update, expectedVersion: current.version };
    if (!changes?.length) return versioned;
    if (Object.hasOwn(update, "value"))
      throw new Error(
        `${update.id}: provide either value or changes, not both`,
      );
    return {
      ...versioned,
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
      'Settle this narrative\'s dimension rules once. Submit a batch of {id, changes | value, reason}. Prefer changes: [{path, value}] to set only the fields or entries that changed (dot path inside the dimension value, e.g. "torn-letter.status"; a new key adds an entry); use value only to replace the whole value. Submit updates: [] to explicitly settle no change. Results must match the declared schema. Never invent facts or copy character/inventory/time state.',
    parameters: z.preprocess(
      normalizeArguments,
      z.strictObject({
        updates: z
          .array(
            z.strictObject({
              id: z.string().min(1),
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
    ),
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
