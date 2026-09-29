/** Structural SDK types; no kernel package is required by consumers. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };
// A type literal (not an interface) so the implicit index signature keeps this
// assignable to the kernel's loose-object media ref contract.
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
