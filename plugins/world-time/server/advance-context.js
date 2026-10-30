import { modelFacingJson } from "@covel/plugin-handlers-utils";
import { describeTime, timeUnits } from "../clock.js";

/**
 * Settlement compares the authoritative clock with the exact current story.
 * Conversation rendering can replace a duplicated narrative slot with a
 * pointer, and the saved clock carries the previous turn's explanation.
 * Neither is evidence of this turn's elapsed time. Trim both here, without
 * changing typed bindings or the public context contract for other readers.
 */
export default function advanceContext(ctx, payload) {
  if (ctx.runtimeId !== "world-time/advance") return { action: "continue" };
  const currentTime = payload.inputSlots?.currentTime;
  const narrative = payload.inputSlots?.narrative;
  if (
    currentTime?.cardinality !== "one" ||
    narrative?.cardinality !== "one" ||
    typeof narrative.value !== "string" ||
    !payload.promptTemplate
  )
    return { action: "continue" };
  const { definition, tick, locale } = currentTime.value;
  return {
    action: "continue",
    replace: {
      systemPrompt: payload.promptTemplate,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            modelFacingJson({
              currentTime: {
                cardinality: "one",
                value: {
                  definition,
                  ...describeTime(definition, tick, locale),
                  units: timeUnits(definition),
                },
              },
              narrative: { cardinality: "one", value: narrative.value },
            }),
          ),
        },
      ],
    },
  };
}
