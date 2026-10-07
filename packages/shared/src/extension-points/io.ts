import type { ExtensionPoint } from "./definition.js";
import type { kernelExtensionPoints } from "./contracts.js";
import type { historyCompactV2 } from "./history-compact.js";
import type { mediaImageFlowV1 } from "./media-image-flow.js";
import type { promptHistoryTransformV1 } from "./prompt-history-transform.js";
import type { promptSegmentV1 } from "./prompt-segment.js";
import type { sessionWorldContextV1 } from "./session-world-context.js";
import type { uiSlotV1 } from "./ui-slot.js";

/** Infer an extension point's handler input type. */
export type ExtensionPointInput<P> =
  P extends ExtensionPoint<infer I, unknown, infer _M> ? I : never;
/** Infer an extension point's handler output type. */
export type ExtensionPointOutput<P> =
  P extends ExtensionPoint<unknown, infer O, infer _M> ? O : never;

type KernelPointId =
  (typeof kernelExtensionPoints)[keyof typeof kernelExtensionPoints]["id"];

/**
 * Versioned input/output contract of every kernel extension point, keyed by
 * point id. `PluginAPI.provideExtension` and the public SDK both bind their
 * handler signatures to this map.
 */
export interface KernelExtensionPointIo {
  readonly "history.compact@2": {
    readonly input: ExtensionPointInput<typeof historyCompactV2>;
    readonly output: ExtensionPointOutput<typeof historyCompactV2>;
  };
  readonly "media.image-flow@1": {
    readonly input: ExtensionPointInput<typeof mediaImageFlowV1>;
    readonly output: ExtensionPointOutput<typeof mediaImageFlowV1>;
  };
  readonly "prompt.history-transform@1": {
    readonly input: ExtensionPointInput<typeof promptHistoryTransformV1>;
    readonly output: ExtensionPointOutput<typeof promptHistoryTransformV1>;
  };
  readonly "prompt.segment@1": {
    readonly input: ExtensionPointInput<typeof promptSegmentV1>;
    readonly output: ExtensionPointOutput<typeof promptSegmentV1>;
  };
  readonly "session.world-context@1": {
    readonly input: ExtensionPointInput<typeof sessionWorldContextV1>;
    readonly output: ExtensionPointOutput<typeof sessionWorldContextV1>;
  };
  readonly "ui.slot@1": {
    readonly input: ExtensionPointInput<typeof uiSlotV1>;
    readonly output: ExtensionPointOutput<typeof uiSlotV1>;
  };
}

// The map keys must stay in lockstep with the contracts table.
type Missing = Exclude<KernelPointId, keyof KernelExtensionPointIo>;
type Extra = Exclude<keyof KernelExtensionPointIo, KernelPointId>;
type Assert<T extends true> = T;
type _NoMissing = Assert<Missing extends never ? true : false>;
type _NoExtra = Assert<Extra extends never ? true : false>;

/** Ids of every kernel extension point. */
export type KernelExtensionPointId = keyof KernelExtensionPointIo;
