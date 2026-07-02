/**
 * Plugin data and trace event record types.
 *
 * Split out of `../types.ts` by domain; re-exported there for compatibility.
 */

export interface PluginDataRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown; // JSON
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TraceEventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly traceId: string;
  readonly turnId: string;
  readonly payload: unknown; // JSON
  readonly createdAt: string;
}
