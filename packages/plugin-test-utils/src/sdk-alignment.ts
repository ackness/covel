/**
 * Compile-time alignment between the public SDK's structural types
 * (`@covel/plugin-handlers-utils`, without private workspace dependencies) and the kernel contracts
 * (`@covel/shared`, zod-derived). If a kernel schema changes, this file fails
 * `tsc --noEmit` until the SDK mirror is updated.
 */

import type {
  KernelExtensionPointIo,
  PluginExtensionContext,
  PluginExtensionDefinition,
  Proposal,
  WorldDimensions,
  WorldModelView,
} from "@covel/shared";
import type {
  ExtensionHandlerContext,
  ExtensionPointIo,
  ExtensionWorldDimensions,
  ExtensionWorldRecord,
  PluginExtensionApi,
  PluginExtensionDefinition as SdkExtensionDefinition,
} from "@covel/plugin-handlers-utils/extension-points";
import type { PluginAPI } from "@covel/runtime";
import type {
  PluginAPI as PublicPluginAPI,
  PluginEntryFactory as PublicPluginEntryFactory,
  HookEventName as PublicHookEventName,
  PluginProposal,
} from "@covel/plugin-handlers-utils/plugin-api";
import type { HookEventName } from "@covel/shared";
import type {
  PluginFunctionContext,
  PluginFunctionHandler,
  PluginAgentGuard,
  FunctionStoreView as PublicFunctionStoreView,
  PluginDataWriter as PublicPluginDataWriter,
  HandlerResult as PublicHandlerResult,
} from "@covel/plugin-handlers-utils";
import type {
  FunctionHandlerContext,
  FunctionHandler,
  AgentGuard,
  FunctionStoreView,
  PluginDataWriter,
} from "@covel/shared/plugin-runtime";
import type { HandlerResult } from "@covel/shared";

type Assert<T extends true> = T;
// Tuple-wrapped operands keep unions intact instead of distributing.
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
type SameKeys<A, B> =
  Exclude<keyof A, keyof B> extends never
    ? Exclude<keyof B, keyof A> extends never
      ? true
      : false
    : false;

type KernelWorldRecord = NonNullable<WorldModelView["worldRecord"]>;
type _SameWorldRecordKeys = Assert<
  SameKeys<KernelWorldRecord, ExtensionWorldRecord>
>;
type _SameWorldRecord = Assert<
  MutuallyAssignable<KernelWorldRecord, ExtensionWorldRecord>
>;
type _SameWorldDimensionsKeys = Assert<
  SameKeys<WorldDimensions, ExtensionWorldDimensions>
>;
type _SameWorldDimensions = Assert<
  MutuallyAssignable<WorldDimensions, ExtensionWorldDimensions>
>;

// The two maps cover exactly the same point ids.
type _SamePointIds = Assert<
  Exclude<keyof KernelExtensionPointIo, keyof ExtensionPointIo> extends never
    ? Exclude<
        keyof ExtensionPointIo,
        keyof KernelExtensionPointIo
      > extends never
      ? true
      : false
    : false
>;

// Inputs and outputs are the same contract on both sides.
type IoMember<P extends keyof KernelExtensionPointIo> = MutuallyAssignable<
  KernelExtensionPointIo[P],
  ExtensionPointIo[P]
>;
type _Compact = Assert<IoMember<"history.compact@1">>;
type _ImageFlow = Assert<IoMember<"media.image-flow@1">>;
type _HistoryTransform = Assert<IoMember<"prompt.history-transform@1">>;
type _Segment = Assert<IoMember<"prompt.segment@1">>;
type _WorldContext = Assert<IoMember<"session.world-context@1">>;
type _UiSlot = Assert<IoMember<"ui.slot@1">>;

// The SDK exposes every kernel extension-context capability with compatible
// signatures. Adding a kernel field must update the public mirror.
type _SameContextKeys = Assert<
  Exclude<
    keyof PluginExtensionContext,
    keyof ExtensionHandlerContext
  > extends never
    ? Exclude<
        keyof ExtensionHandlerContext,
        keyof PluginExtensionContext
      > extends never
      ? true
      : false
    : false
>;
type _SameContext = Assert<
  MutuallyAssignable<PluginExtensionContext, ExtensionHandlerContext>
>;

// A definition authored against the SDK satisfies the kernel's definition.
type Def<P extends keyof ExtensionPointIo> = PluginExtensionDefinition<
  KernelExtensionPointIo[P & keyof KernelExtensionPointIo]["input"],
  KernelExtensionPointIo[P & keyof KernelExtensionPointIo]["output"]
>;
type _SdkDef<P extends keyof ExtensionPointIo> =
  SdkExtensionDefinition<P> extends Def<P> ? true : false;
type _DefCompact = Assert<_SdkDef<"history.compact@1">>;
type _DefImageFlow = Assert<_SdkDef<"media.image-flow@1">>;
type _DefHistoryTransform = Assert<_SdkDef<"prompt.history-transform@1">>;
type _DefSegment = Assert<_SdkDef<"prompt.segment@1">>;
type _DefWorldContext = Assert<_SdkDef<"session.world-context@1">>;
type _DefUiSlot = Assert<_SdkDef<"ui.slot@1">>;

// PluginAPI.provideExtension accepts exactly the SDK-typed definitions.
type _ApiProvide = Assert<
  PluginAPI["provideExtension"] extends (
    point: infer _P,
    id: string,
    definition: infer _D,
  ) => void
    ? true
    : false
>;
declare const api: PluginExtensionApi;
api.provideExtension("prompt.segment@1", "segments", {
  handler: (input, context) => {
    const turnId: string = input.turnId;
    const world = context.world.characters;
    void [turnId, world, context.pluginData.get("values", "one")];
    return [
      {
        id: "s1",
        content: "x",
        position: "system" as const,
        audience: "all" as const,
        volatility: "turn" as const,
      },
    ];
  },
});
api.provideExtension("history.compact@1", "compact", {
  handler: async (_input, context) => {
    const response = await context.gateway?.generateText({
      prompt: "Summarize",
    });
    const verdict = context.utils?.validateBaseUrl("https://example.com");
    const result = context.utils?.fetchWithRetry("https://example.com");
    // @ts-expect-error The service gateway has no write-capable store surface.
    context.gateway?.getSession();
    void [verdict, result];
    return { messageIds: [], content: response?.text ?? "", focusSections: [] };
  },
});

// The implementation facade must provide every operation promised by the
// standalone SDK. The reverse check catches SDK signatures that accidentally
// accept values the kernel cannot handle.
declare const kernelApi: PluginAPI;
declare const publicApi: PublicPluginAPI;
const _publicApi: PublicPluginAPI = kernelApi;
const _kernelApi: PluginAPI = publicApi;
const _entry: PublicPluginEntryFactory = (api) => {
  api.on("TurnStart", async () => ({ action: "continue" }));
  api.registerRpc("inspect", async (_payload, context) => {
    await context.store.listTurnMessages();
    return { ok: true };
  });
  api.registerFormValidator("sample", (values) =>
    values.name === undefined ? "name is required" : undefined,
  );
  api.registerWires({ image: [] });
};
type _SameHookEvents = Assert<
  MutuallyAssignable<HookEventName, PublicHookEventName>
>;
type _SameProposals = Assert<MutuallyAssignable<Proposal, PluginProposal>>;
type _SameStore = Assert<
  MutuallyAssignable<FunctionStoreView, PublicFunctionStoreView>
>;
type _SameWriter = Assert<
  MutuallyAssignable<PluginDataWriter, PublicPluginDataWriter>
>;
type _SameHandlerResult = Assert<
  MutuallyAssignable<HandlerResult, PublicHandlerResult>
>;
type _HostProvidesFunctionCore = Assert<
  FunctionHandlerContext extends PluginFunctionContext ? true : false
>;
type _PublicHandlerRunsOnHost = Assert<
  PluginFunctionHandler extends FunctionHandler ? true : false
>;
type _PublicGuardRunsOnHost = Assert<
  PluginAgentGuard extends AgentGuard ? true : false
>;
// Known-point registration is closed at compile time on both entry surfaces.
// @ts-expect-error Unknown point ids are not part of the current contract.
publicApi.provideExtension("unknown.point@1", "bad", { handler: () => null });
// @ts-expect-error Unknown point ids are not part of the current contract.
kernelApi.provideExtension("unknown.point@1", "bad", { handler: () => null });
// @ts-expect-error This point must return prompt segments, not a scalar.
publicApi.provideExtension("prompt.segment@1", "bad", { handler: () => 1 });
// @ts-expect-error This point must return prompt segments, not a scalar.
kernelApi.provideExtension("prompt.segment@1", "bad", { handler: () => 1 });
void [_publicApi, _kernelApi, _entry];
