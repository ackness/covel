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
 * The UUIDs that link one part of a value to another: the `id` of a record
 * that something else in the same value names, such as a World IR entity and
 * the relations and events that point to it. Those are references, not
 * bookkeeping. Dropping only the `id` would leave the model references it
 * cannot resolve, so a linked UUID stays wherever it appears. A record that
 * repeats its own `id` in another of its properties links nothing.
 */
function linkedUuids(value: unknown): ReadonlySet<string> {
  const defined = new Set<string>();
  const named = new Set<string>();
  const visit = (item: unknown, name?: string, ownId?: unknown): void => {
    if (name === "sessionId") return;
    if (typeof item === "string") {
      if (!isUuid(item)) return;
      if (name === "id") defined.add(item);
      else if (item !== ownId) named.add(item);
    } else if (Array.isArray(item)) {
      for (const element of item) visit(element);
    } else if (item !== null && typeof item === "object") {
      const own = (item as { id?: unknown }).id;
      for (const [key, child] of Object.entries(item)) visit(child, key, own);
    }
  };
  visit(value);
  return new Set([...defined].filter((uuid) => named.has(uuid)));
}

/**
 * Whether a property is bookkeeping. The name and the value must both say so:
 * `turnId` with a UUID, `evidenceTurnIds` with a list of UUIDs, `updatedAt`
 * or `timestamp` with an ISO time. `id: "npc-lin-yao"` and
 * `date: "1943-06-01T08:00:00Z"` stay, and so does a UUID in `linked`.
 * `sessionId` goes whatever it holds: a session may be named by a test.
 */
function isBookkeeping(
  name: string,
  value: unknown,
  linked: ReadonlySet<string>,
): boolean {
  if (name === "sessionId") return true;
  if (name === "id" || /Ids?$/.test(name)) {
    const ids: readonly unknown[] = Array.isArray(value) ? value : [value];
    return (
      ids.length > 0 &&
      ids.every(isUuid) &&
      !ids.some((id) => linked.has(id as string))
    );
  }
  return isBookkeepingTime(name, value);
}

/** The time branch of the rule: `updatedAt` or `timestamp` with an ISO time. */
function isBookkeepingTime(name: string, value: unknown): boolean {
  return (
    (name === "timestamp" || name.endsWith("At")) &&
    typeof value === "string" &&
    INSTANT.test(value)
  );
}

function project(value: unknown, linked: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => project(item, linked));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, item]) => !isBookkeeping(name, item, linked))
      .map(([name, item]) => [name, project(item, linked)]),
  );
}

/**
 * A copy of a JSON value without its bookkeeping properties, at every depth.
 * Use it where code writes a record into a prompt or a tool result. Pass the
 * whole value at once: a UUID that links its parts is kept only when both the
 * record and the reference are in the value.
 */
export function modelFacingJson<T>(value: T): T {
  return project(value, linkedUuids(value)) as T;
}

/** Why `modelFacingJson` leaves a property out. */
export type ModelHiddenReason = "time" | "uuid";

export interface ModelHiddenPath {
  /** Where the property is: `fields.diedAt`, `[2].timestamp`, `[0].id`. */
  path: string;
  /** `time`: it reads as the time a row was written. `uuid`: an ID that is a UUID. */
  reason: ModelHiddenReason;
}

/**
 * The properties that `modelFacingJson` leaves out of a value, with the
 * reason. An author who stored a date of the story as `diedAt`, or gave a
 * record a UUID for its `id`, learns from this list that no model reads it.
 * `sessionId` is not listed: authored data has no use for one.
 */
export function modelHiddenPaths(value: unknown, at = ""): ModelHiddenPath[] {
  return hiddenPaths(value, at, linkedUuids(value));
}

function hiddenPaths(
  value: unknown,
  at: string,
  linked: ReadonlySet<string>,
): ModelHiddenPath[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      hiddenPaths(item, `${at}[${index}]`, linked),
    );
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, item]) => {
    const path = at ? `${at}.${name}` : name;
    if (isBookkeepingTime(name, item)) return [{ path, reason: "time" }];
    // A property that is left out hides what is under it.
    if (!isBookkeeping(name, item, linked))
      return hiddenPaths(item, path, linked);
    return name === "sessionId" ? [] : [{ path, reason: "uuid" }];
  });
}
