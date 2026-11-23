/**
 * Non-secret instance-scoped plugin KV records.
 *
 * Split out of `../types.ts` by domain; re-exported there as the public entry point.
 */

export interface InstanceDataRecord {
  readonly pluginId: string;
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown; // JSON
  readonly createdAt: string;
  readonly updatedAt: string;
}
