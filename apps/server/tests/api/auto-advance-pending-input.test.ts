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

const reads = { messages: 0, answers: 0 };

function pending(
  messages: TurnMessageRecord[],
  answers: { turnId: string; formId: string }[] = [],
) {
  return hasPendingAdvanceInput(
    {
      listSuspensions: async () => [],
      listRecentTurnMessages: async (_sessionId, limit) => {
        reads.messages = Math.max(reads.messages, limit);
        return messages.slice(-limit);
      },
      listPlayerInputs: async () => {
        reads.answers += 1;
        return answersOf(answers);
      },
    },
    "s",
  );
}

function answersOf(answers: { turnId: string; formId: string }[]) {
  return answers.map((answer, index) => ({
    ...answer,
    id: `a${index}`,
    sessionId: "s",
    values: {},
    createdAt: "2026-11-04T00:00:00.000Z",
  }));
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

describe("hasPendingAdvanceInput reads", () => {
  it("reads only the end of a long log, and answers only when needed", async () => {
    reads.messages = 0;
    reads.answers = 0;
    const history = Array.from({ length: 5000 }, (_, index) =>
      message(`t${index}`, index % 2 ? "assistant" : "user"),
    );
    await expect(pending(history)).resolves.toBe(false);
    expect(reads.messages).toBeLessThan(history.length);
    expect(reads.answers).toBe(0);
  });

  it("widens the window until it reaches the player's last message", async () => {
    const generated = Array.from({ length: 300 }, (_, index) =>
      message(`g${index}`, "assistant"),
    );
    await expect(
      pending([
        message("t0", "user"),
        message("t0", "assistant", choice),
        ...generated,
      ]),
    ).resolves.toBe(true);
  });
});
