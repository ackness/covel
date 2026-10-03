import { z } from "zod";
import { worldTimeSchema } from "../schema.js";
import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";

import { advanceTime, describeTime } from "../clock.js";

export default function ({ tool }) {
  return tool({
    name: "advance-world-time",
    description:
      "Settle this narrative turn's elapsed world time. Submit a duration, never do calendar arithmetic. For random mode omit amount, unit and direction. Zero is valid for a frozen moment. All writes commit with the story.",
    parameters: z
      .object({
        amount: z.number().int().min(0).max(1_000_000).optional(),
        unit: z
          .enum(["minute", "hour", "day", "phase", "cycle"])
          .optional()
          .describe("One of the units in currentTime.value.units."),
        direction: z.enum(["forward", "backward"]).optional(),
        reason: z
          .string()
          .min(1)
          .max(1000)
          .describe("One short sentence: what took this time."),
      })
      .strict(),
    execute: async (request, context) => {
      const slot = context.inputSlots?.currentTime;
      const narrative = context.inputSlots?.narrative;
      if (
        !slot ||
        !("value" in slot) ||
        !narrative ||
        !("value" in narrative) ||
        typeof narrative.value !== "string" ||
        !narrative.value.trim()
      ) {
        throw new Error(
          "World time requires currentTime and a successful same-turn narrative input",
        );
      }
      const base = slot.value;
      const definition = worldTimeSchema.parse(base.definition);
      if (!Number.isSafeInteger(base.tick))
        throw new Error("Invalid current time tick");
      const previous = await context.store.getPluginData("clock", "current");
      if (previous?.value?.lastTurnId === context.turnId)
        return { ...previous.value };
      if (previous && previous.value.tick !== base.tick)
        throw new Error("World time changed since this narrative started");
      const next = advanceTime(definition, base.tick, request, context.turnId);
      const value = {
        schemaVersion: 1,
        definition,
        tick: next.tick,
        ...describeTime(definition, next.tick, base.locale),
        lastTurnId: context.turnId,
        lastDelta: next.delta,
        reason: request.reason,
      };
      return withPendingProposals(value, [
        makeProposal(context, new Date().toISOString(), "plugin.data", {
          namespace: "clock",
          key: "current",
          value,
        }),
      ]);
    },
  });
}
