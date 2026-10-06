// A model does not count characters. Asked for at most 200 it wrote 201,
// 219, and 245, and each such write was rejected and cost another model
// call. Shown 160 for the same field it wrote 208 at most. The limit that is
// checked stays the author's.
const TEXT_LIMIT_SHOWN = 0.8;

/**
 * The limit shown for one string schema. It is never below `minLength`, or
 * the model is shown limits no text can meet. A text with fixed values
 * (`const`, `enum`) keeps the author's limit: the model copies such a value,
 * it does not write one.
 */
function shownMaxLength(schema, maxLength) {
  if ("const" in schema || "enum" in schema) return maxLength;
  const minLength = Number.isInteger(schema.minLength) ? schema.minLength : 1;
  return Math.min(
    maxLength,
    Math.max(1, minLength, Math.floor(maxLength * TEXT_LIMIT_SHOWN)),
  );
}

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
        ? shownMaxLength(schema, value)
        : schemaForTracker(value),
    ]),
  );
}
