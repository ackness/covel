/** Operation kinds a plugin-data update may contain. */
export const DATA_OP_KINDS = [
  "set",
  "merge",
  "inc",
  "append",
  "insert",
  "remove",
  "upsertItem",
  "delete",
] as const;

export type DataOpKind = (typeof DATA_OP_KINDS)[number];
