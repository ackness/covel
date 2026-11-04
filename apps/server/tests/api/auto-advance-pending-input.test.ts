import { describe, expect, it } from "vitest";
import type { TurnMessageRecord } from "@covel/store";
import { hasPendingAdvanceInput } from "../../src/routes/api/actions/auto-advance.js";

const choice = [{ interactionId: "route", type: "choice" }];

function message(
  turnId: string,
  role: string,
  pendingInput?: unknown,
): TurnMessageRecord {
  return {
    id: `${turnId}-${role}`,
    sessionId: "s",
    turnId,
    sourceType: role === "user" ? "player" : "runtime",
    role,
    content: "",
    order: 0,
    createdAt: "2026-11-04T00:00:00.000Z",
    ...(pendingInput ? { pendingInput } : {}),
  };
}

function pending(
  messages: TurnMessageRecord[],
  answers: { turnId: string; formId: string }[] = [],
) {
  return hasPendingAdvanceInput(
    {
      listSuspensions: async () => [],
      listTurnMessages: async () => messages,
      listPlayerInputs: async () =>
        answers.map((answer, index) => ({
          ...answer,
          id: `a${index}`,
          sessionId: "s",
          values: {},
          createdAt: "2026-11-04T00:00:00.000Z",
        })),
    },
    "s",
  );
}

describe("hasPendingAdvanceInput", () => {
  it("waits for a choice offered after the player's last message", async () => {
    await expect(
      pending([message("t1", "user"), message("t1", "assistant", choice)]),
    ).resolves.toBe(true);
  });

  it("ignores a choice the player answered by typing instead", async () => {
    await expect(
      pending([
        message("t1", "assistant", choice),
        message("t2", "user"),
        message("t2", "assistant"),
      ]),
    ).resolves.toBe(false);
  });

  it("stops waiting once the choice is answered", async () => {
    await expect(
      pending(
        [message("t1", "user"), message("t1", "assistant", choice)],
        [{ turnId: "t1", formId: "route" }],
      ),
    ).resolves.toBe(false);
  });
});
