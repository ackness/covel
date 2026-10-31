import { describe, it } from "vitest";
import {
  assertPrivateActorComposition,
  compositionScenarios,
} from "./_helpers/actor-agent-composition.js";

describe.each([false, true])(
  "private actor composition (concealed: %s)",
  (concealed) => {
    it.each(compositionScenarios)(
      "protects traces and preserves live model context with %s",
      async (scenario) => {
        await assertPrivateActorComposition({ concealed, scenario });
      },
    );
  },
);
