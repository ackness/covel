/**
 * A stored record as a model should read it.
 *
 * A record carries bookkeeping the model has no use for: the session ID, the
 * UUIDs of rows, turns and results, and the times a row was written. Each one
 * costs tokens, a model that copies one copies it wrong, a timestamp changes
 * the prompt whenever the row is rewritten, and none is the same in two runs
 * of one session. Code keeps reading the full record; only the text built for
 * a model goes through here.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isUuid = (value: unknown) =>
  typeof value === "string" && UUID.test(value);

/**
 * Whether a property is bookkeeping. The name and the value must both say so:
 * `turnId` with a UUID, `evidenceTurnIds` with a list of UUIDs, `updatedAt`
 * or `timestamp` with an ISO time. `id: "npc-lin-yao"` and
 * `date: "1943-06-01T08:00:00Z"` stay. `sessionId` goes whatever it holds: a
 * session may be named by a test.
 */
function isBookkeeping(name: string, value: unknown): boolean {
  if (name === "sessionId") return true;
  if (name === "id" || /Ids?$/.test(name)) {
    return Array.isArray(value)
      ? value.length > 0 && value.every(isUuid)
      : isUuid(value);
  }
  return (
    (name === "timestamp" || name.endsWith("At")) &&
    typeof value === "string" &&
    INSTANT.test(value)
  );
}

/**
 * A copy of a JSON value without its bookkeeping properties, at every depth.
 * Use it where code writes a record into a prompt or a tool result.
 */
export function modelFacingJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(modelFacingJson) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, item]) => !isBookkeeping(name, item))
      .map(([name, item]) => [name, modelFacingJson(item)]),
  ) as T;
}
