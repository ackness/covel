import { describe, expect, it } from "vitest";
import {
  autoAdvanceLimitSchema,
  resolveAutoAdvanceLimit,
} from "../src/schemas/session-settings.js";
import { createSessionRequestSchema } from "../src/schemas/api-contract.js";

describe("automatic advancement limit", () => {
  it("defaults to three additional rounds and accepts the bounded integers", () => {
    expect(resolveAutoAdvanceLimit(undefined)).toBe(3);
    for (let limit = 0; limit <= 10; limit += 1) {
      expect(resolveAutoAdvanceLimit(limit)).toBe(limit);
      expect(
        createSessionRequestSchema.parse({ autoAdvanceLimit: limit })
          .autoAdvanceLimit,
      ).toBe(limit);
    }
  });
  it.each([-1, 11, 0.5, "3", null, NaN, Infinity])(
    "rejects invalid limit %s",
    (limit) => {
      expect(autoAdvanceLimitSchema.safeParse(limit).success).toBe(false);
      expect(
        createSessionRequestSchema.safeParse({ autoAdvanceLimit: limit })
          .success,
      ).toBe(false);
    },
  );
});
