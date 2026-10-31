import { PresentationUnavailable } from "./projection.js";
import type { PluginRuntimeGateway } from "@covel/shared/plugin-runtime";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import type { PresentationState } from "./state.js";
import { PresentationBudgetExhausted } from "@covel/shared";

/** Common dispatch boundary, inside stalled retries and below helper caches. */
export function presentationGateway(
  gateway: PluginRuntimeGateway,
  state: PresentationState,
  assertLive: () => void,
  emitter?: TurnEmitter,
): PluginRuntimeGateway {
  const identity = {
    pluginId: state.snapshot.pluginId,
    runtimeId: state.snapshot.runtimeId,
    sourceTurnId: state.snapshot.sourceTurnId,
  };
  const dispatch = async <T>(
    method: string,
    units: number,
    send: () => Promise<T>,
  ): Promise<T> => {
    assertLive();
    if (!state.snapshot.story) throw new PresentationUnavailable();
    try {
      await state.budget.reserve(units);
    } catch (error) {
      if (error instanceof PresentationBudgetExhausted)
        state.reason = "budget-exhausted";
      throw error;
    }
    assertLive();
    await emitter?.emit("gateway.calling", { ...identity, method });
    assertLive();
    try {
      const result = await send();
      await emitter?.emit("gateway.responded", { ...identity, method });
      return result;
    } catch (error) {
      await emitter?.emit("gateway.failed", {
        ...identity,
        method,
        reason: "failed",
      });
      throw error;
    }
  };
  const facade: PluginRuntimeGateway = {
    resolveSlot: (input) => {
      assertLive();
      return gateway.resolveSlot(input);
    },
    generateText: (input) =>
      dispatch("generateText", 0, () => gateway.generateText(input)),
    generateObject: <T>(
      input: Parameters<PluginRuntimeGateway["generateObject"]>[0],
    ) => dispatch("generateObject", 0, () => gateway.generateObject<T>(input)),
  };
  if (gateway.generateImage)
    facade.generateImage = (input) => {
      const units = input.n ?? 1;
      if (!Number.isSafeInteger(units) || units < 1 || units > 4)
        throw new RangeError(
          "Presentation image count must be an integer from 1 to 4",
        );
      return dispatch("generateImage", units, () =>
        gateway.generateImage!(input),
      );
    };
  if (gateway.composeMusic)
    facade.composeMusic = (input) =>
      dispatch("composeMusic", 1, () => gateway.composeMusic!(input));
  if (gateway.synthesizeSpeech)
    facade.synthesizeSpeech = (input) =>
      dispatch("synthesizeSpeech", 1, () => gateway.synthesizeSpeech!(input));
  return facade;
}

/** Probes expose availability and target identity, never transport credentials. */
export function publicPresentationGateway(
  gateway: PluginRuntimeGateway,
): PluginRuntimeGateway {
  return {
    ...gateway,
    resolveSlot(input) {
      const slot = gateway.resolveSlot(input);
      return slot
        ? {
            presetId: slot.presetId,
            provider: slot.provider,
            protocol: slot.protocol,
            model: slot.model,
            tag: slot.tag,
            metadata: {},
            ...(slot.limits ? { limits: { ...slot.limits } } : {}),
          }
        : null;
    },
    ...(gateway.generateImage
      ? {
          generateImage: async (
            input: Parameters<
              NonNullable<PluginRuntimeGateway["generateImage"]>
            >[0],
          ) => {
            const result = await gateway.generateImage!(input);
            return {
              ...result,
              target: {
                provider: result.target.provider,
                model: result.target.model,
                protocol: result.target.protocol,
                metadata: {},
              },
            };
          },
        }
      : {}),
  };
}
