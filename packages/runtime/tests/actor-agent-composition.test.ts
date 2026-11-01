import { describe, it } from "vitest";
import {
  assertPrivateActorComposition,
  compositionScenarios,
} from "./_helpers/actor-agent-composition.js";

describe.each(
  [false, true].flatMap((concealed) =>
    [false, true].map((batch) => ({ concealed, batch })),
  ),
)(
  "private actor composition (concealed: $concealed, batch: $batch)",
  ({ concealed, batch }) => {
    it.each(compositionScenarios)(
      "protects traces and preserves live model context with %s",
      async (scenario) => {
        await assertPrivateActorComposition({ concealed, scenario, batch });
      },
    );
  },
);
