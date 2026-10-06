// A model does not count characters. Asked for at most 200 it wrote 201,
// 219, and 245, and each such write was rejected and cost another model
// call. Shown 160 for the same field it wrote 208 at most. The limit that is
// checked stays the author's.
const TEXT_LIMIT_SHOWN = 0.8;

/**
 * The schema of a dimension as the tracker reads it: every `maxLength` is
 * lowered, so that a text written a little over what the model was told
 * still fits the limit the author set.
 */
export function schemaForTracker(schema) {
  if (Array.isArray(schema)) return schema.map(schemaForTracker);
  if (schema === null || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "maxLength" && Number.isInteger(value) && value > 1
        ? Math.max(1, Math.floor(value * TEXT_LIMIT_SHOWN))
        : schemaForTracker(value),
    ]),
  );
}
