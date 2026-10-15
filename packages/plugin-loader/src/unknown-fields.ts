/**
 * Fields a manifest declares that this host does not know.
 *
 * Loading leaves such a field out and warns, so a package with a leftover or
 * newer field keeps working; `pnpm validate:plugin` reports the same field as
 * an error. Only a whole field is left out: one at the top of PLUGIN.md, of a
 * RUNTIME.md or of the inline `runtime`, a whole entry under `contributes`
 * (including UI placements), or a field of a data namespace's
 * `authoring.source`. Every field the host keeps then means exactly what it
 * says.
 *
 * Two kinds of unknown key still reject the manifest, because leaving them
 * out could widen what the author declared:
 * - a key inside a field the host knows (`permissions.http[0].method`,
 *   `io.conceal`, `schedule.trigger.cooldown`): the host would otherwise run
 *   a declaration it only partly understood;
 * - a near-misspelling of a field that limits or identifies the package
 *   (`permision`, `gaurd`, `covle`): it is most likely that field.
 */

interface UnknownKeyIssue {
  readonly code?: string;
  readonly path: readonly PropertyKey[];
  readonly keys?: readonly string[];
  readonly message: string;
}

/** Runtime fields that limit what a runtime does or when it runs. */
const GUARDED_RUNTIME_FIELDS = [
  "guard",
  "permissions",
  "effects",
  "schedule",
  "io",
  "function",
] as const;

/** Where a whole unknown field may be left out, and which known names it must not resemble. */
const OPEN_LOCATIONS = {
  plugin: [
    {
      path: [],
      guarded: [
        "id",
        "kind",
        "version",
        "covel",
        "provides",
        "requires",
        "conflicts",
        "permissions",
        "entry",
        "runtime",
      ],
    },
    { path: ["contributes"], guarded: [] },
    // An unsupported placement removes only that panel, never the package.
    { path: ["contributes", "ui"], guarded: [] },
    // Where world authors put a file is no runtime behaviour; `visibility`
    // keeps hidden content hidden and is never ignored.
    {
      path: ["contributes", "data", "*", "authoring", "source"],
      guarded: ["path", "key", "visibility"],
    },
    { path: ["runtime"], guarded: GUARDED_RUNTIME_FIELDS },
  ],
  runtime: [{ path: [], guarded: GUARDED_RUNTIME_FIELDS }],
} as const satisfies Record<
  string,
  readonly { path: readonly string[]; guarded: readonly string[] }[]
>;

export type ManifestForm = keyof typeof OPEN_LOCATIONS;

/** An unknown whole field, as found in one manifest file. */
export interface UnknownField {
  /** Path of the object that holds it. */
  readonly at: readonly string[];
  readonly key: string;
}

/** `*` in a location stands for any key, such as a data namespace. */
function samePath(a: readonly PropertyKey[], b: readonly string[]): boolean {
  return (
    a.length === b.length &&
    a.every((segment, i) => b[i] === "*" || segment === b[i])
  );
}

/** Edit distance with adjacent transpositions, on lower-cased names. */
function distance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const d: number[][] = Array.from({ length: s.length + 1 }, (_, i) =>
    Array.from({ length: t.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= s.length; i++)
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let best = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1])
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  return d[s.length]![t.length]!;
}

/** The guarded field an unknown key most likely misspells. */
export function misspelledGuardedField(
  key: string,
  guarded: readonly string[],
): string | undefined {
  return guarded.find((name) => {
    const edits = distance(key, name);
    if (edits === 0) return true;
    // Short names collide easily (`ui` is not `io`): demand the same first
    // letter and a single edit.
    if (Math.min(key.length, name.length) < 4)
      return edits === 1 && key[0]?.toLowerCase() === name[0];
    return edits <= 2;
  });
}

function location(form: ManifestForm, path: readonly PropertyKey[]) {
  return OPEN_LOCATIONS[form].find((open) => samePath(path, open.path));
}

/** The unknown whole fields of one issue that loading may leave out. */
export function ignorableUnknownFields(
  form: ManifestForm,
  issue: UnknownKeyIssue,
): UnknownField[] {
  if (issue.code !== "unrecognized_keys") return [];
  const open = location(form, issue.path);
  if (!open) return [];
  return (issue.keys ?? [])
    .filter((key) => !misspelledGuardedField(key, open.guarded))
    .map((key) => ({ at: issue.path.map(String), key }));
}

/**
 * The message for an unknown key that still rejects the manifest, or the
 * issue's own message when it is some other problem.
 */
export function unknownKeyMessage(
  form: ManifestForm,
  issue: UnknownKeyIssue,
): string {
  if (issue.code !== "unrecognized_keys") return issue.message;
  const keys = issue.keys ?? [];
  const open = location(form, issue.path);
  if (!open)
    return `unknown field ${keys.map((key) => `"${key}"`).join(", ")} inside a declaration this host reads; remove it or correct its name`;
  return keys
    .map((key) => {
      const meant = misspelledGuardedField(key, open.guarded);
      return meant
        ? `unknown field "${key}" looks like "${meant}"; a field that limits or identifies the package is never ignored, so spell it exactly`
        : `unknown field "${key}"`;
    })
    .join("; ");
}

function withoutField(
  value: unknown,
  at: readonly string[],
  key: string,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (at.length === 0) {
    const { [key]: _removed, ...rest } = record;
    return rest;
  }
  const [head, ...rest] = at;
  return { ...record, [head!]: withoutField(record[head!], rest, key) };
}

/**
 * Parse a manifest, leaving out the unknown whole fields loading may ignore.
 * Returns the last parse result and the fields it left out.
 */
export function parseLeavingOutUnknownFields<
  R extends
    | { success: true }
    | { success: false; error: { issues: readonly UnknownKeyIssue[] } },
>(
  form: ManifestForm,
  data: Record<string, unknown>,
  parse: (data: Record<string, unknown>) => R,
): { result: R; data: Record<string, unknown>; ignored: UnknownField[] } {
  const ignored: UnknownField[] = [];
  let current = data;
  // Each pass sees the unknown keys of every object it reaches; a field left
  // out can expose nothing new, so two passes settle it.
  for (let pass = 0; pass < 3; pass++) {
    const result = parse(current);
    if (result.success) return { result, data: current, ignored };
    const found = result.error.issues.flatMap((issue) =>
      ignorableUnknownFields(form, issue),
    );
    if (!found.length) return { result, data: current, ignored };
    for (const field of found)
      current = withoutField(current, field.at, field.key) as Record<
        string,
        unknown
      >;
    ignored.push(...found);
  }
  return { result: parse(current), data: current, ignored };
}
