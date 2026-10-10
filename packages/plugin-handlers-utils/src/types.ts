/** Structural SDK types; no kernel package is required by consumers. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
// A type literal (not an interface) so the implicit index signature keeps this
// assignable to the kernel's loose-object media ref contract.
/**
 * One entry of a plugin's own data, as `ctx.pluginData.list` returns it in
 * every context. The timestamps are ISO strings; an entry the current
 * execution wrote and has not committed yet carries the time of the read.
 */
export type PluginDataEntry = {
  readonly key: string;
  readonly value: unknown;
  readonly createdAt?: string;
  readonly updatedAt?: string;
};
/**
 * Reads of a plugin's own data. A function handler, a guard and an extension
 * handler all get this shape: `get` returns the stored value itself.
 */
export interface PluginDataReader {
  /** The stored value for a key, or `null` when there is none. */
  get(namespace: string, key: string): Promise<unknown>;
  /** Every entry of a namespace, earliest-created first (store order). */
  list(namespace: string): Promise<readonly PluginDataEntry[]>;
}
export type MediaReference = {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
};
export type ImageGenerationResult =
  | {
      readonly outcome: "success";
      readonly value: JsonValue;
      readonly effects: {
        readonly pluginData: readonly {
          readonly namespace: string;
          readonly key: string;
          readonly value: JsonValue;
        }[];
        readonly assetGenerations?: readonly {
          readonly ref: MediaReference;
          readonly modality: string;
          readonly meta?: Readonly<Record<string, unknown>>;
        }[];
      };
    }
  | { readonly outcome: "skipped"; readonly skipReason: string }
  | { readonly outcome: "failed"; readonly error: string };
