/**
 * One server-scoped setting: a value the server itself acts on, the same for
 * every browser of the install. It belongs to no session.
 */
export interface ServerSettingRecord {
  readonly key: string;
  /** Any JSON value except `null`; a key that is not set has no row. */
  readonly value: unknown;
  readonly updatedAt: string;
}
