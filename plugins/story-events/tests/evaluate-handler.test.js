import { describe, expect, it } from "vitest";
import handler from "../runtimes/evaluate/handler.js";

const event = {
  id: "lighthouse-orphan",
  title: { "zh-CN": "灯塔托孤", "en-US": "The Lighthouse Charge" },
  when: {
    all: [
      { time: "phase", in: [3, 4] },
      { dimension: "location", equals: "lighthouse" },
    ],
  },
  payload: {
    "zh-CN": "老人把孩子交到你手里。",
    "en-US": "The old keeper hands you a child.",
  },
};

function makeCtx({
  location = "lighthouse",
  phase = 3,
  revealed = {},
  turnId = "t-1",
  sourceTurnId,
  planned = {},
} = {}) {
  const data = {
    "_hidden.events": { [event.id]: event },
    "_hidden.planned": { ...planned },
    revealed: { ...revealed },
  };
  const writes = [];
  return {
    writes,
    ctx: {
      locale: "en-US",
      turnId,
      ...(sourceTurnId ? { execution: { sourceTurnId } } : {}),
      inputs: {
        worldTime: { value: { phase } },
        dimensions: { value: { location: { value: location, version: 1 } } },
      },
      logicalTurn: 5,
      pluginData: {
        list: async (namespace) =>
          Object.entries(data[namespace] ?? {}).map(([key, value]) => ({
            key,
            value,
          })),
        set: async (namespace, key, value) => {
          writes.push({ namespace, key, value });
        },
      },
    },
  };
}

describe("evaluate handler", () => {
  it("stays silent and writes nothing until the conditions are met", async () => {
    const { ctx, writes } = makeCtx({ location: "harbor" });
    const result = await handler(ctx);
    expect(result.value.cue).toBeNull();
    expect(JSON.stringify(result)).not.toContain("child");
    expect(writes).toEqual([]);
  });

  it("reveals the event as this turn's cue and records a payload-free reveal", async () => {
    const { ctx, writes } = makeCtx();
    const result = await handler(ctx);
    expect(result.value.cue).toEqual({
      eventId: "lighthouse-orphan",
      title: "The Lighthouse Charge",
      payload: "The old keeper hands you a child.",
    });
    expect(result.value.cueContext).toContain(
      "The old keeper hands you a child.",
    );
    expect(writes).toEqual([
      {
        namespace: "revealed",
        key: "lighthouse-orphan",
        value: {
          eventId: "lighthouse-orphan",
          title: event.title,
          firstTurn: 5,
          lastTurn: 5,
          lastTurnId: "t-1",
          count: 1,
        },
      },
    ]);
    expect(JSON.stringify(writes)).not.toContain("child");
  });

  it("writes the cue instruction in the instruction language of the session", async () => {
    const cue = async (locale) => {
      const { ctx } = makeCtx();
      const { cueContext } = (await handler({ ...ctx, locale })).value;
      return cueContext.slice(0, cueContext.indexOf("\n\n"));
    };
    expect(await cue("zh-CN")).toContain("隐藏的故事事件");
    expect(await cue("zh-CN")).not.toMatch(/[A-Za-z]/);
    for (const locale of ["en-US", "zh-Hant-TW", "ru-RU"])
      expect(await cue(locale)).toBe(
        "A hidden story event has just been unlocked by the current state. Bring it into this turn naturally, as something that happens in the scene; do not mention conditions, triggers, or that it was hidden.",
      );
  });

  it("keeps the text of a turn with no event, which the narrative prompts name", async () => {
    for (const locale of ["zh-CN", "en-US"]) {
      const { ctx } = makeCtx({ location: "harbor" });
      const result = await handler({ ...ctx, locale });
      expect(result.value.cueContext).toBe("No hidden story event this turn.");
    }
  });

  it("re-delivers the same cue when its source turn is retried", async () => {
    const { ctx, writes } = makeCtx({
      turnId: "t-retry",
      sourceTurnId: "t-1",
      revealed: {
        "lighthouse-orphan": { lastTurn: 5, lastTurnId: "t-1", count: 1 },
      },
    });
    const result = await handler(ctx);
    expect(result.value.cue?.eventId).toBe("lighthouse-orphan");
    expect(writes).toEqual([]);
  });

  it("does not fire a once event again on a later turn", async () => {
    const { ctx } = makeCtx({
      turnId: "t-2",
      revealed: {
        "lighthouse-orphan": { lastTurn: 5, lastTurnId: "t-1", count: 1 },
      },
    });
    expect((await handler(ctx)).value.cue).toBeNull();
  });

  it("gives last turn's event once more, as a reminder, and then no more", async () => {
    const fired = { lastTurn: 4, lastTurnId: "t-1", count: 1 };
    const { ctx, writes } = makeCtx({
      turnId: "t-2",
      revealed: { "lighthouse-orphan": fired },
    });
    const result = await handler(ctx);
    expect(result.value.cue).toMatchObject({
      eventId: "lighthouse-orphan",
      reminder: true,
    });
    // The narrative is told to check its previous turn, not to fire it anew.
    expect(result.value.cueContext).toMatch(
      /^The hidden story event below was given to the narrative in the previous turn\./,
    );
    expect(result.value.cueContext).toContain("hands you a child");
    expect(writes).toEqual([
      {
        namespace: "revealed",
        key: "lighthouse-orphan",
        value: { ...fired, reminderTurnId: "t-2" },
      },
    ]);

    const reminded = { "lighthouse-orphan": writes[0].value };
    // A retry of the reminder turn gets the reminder again.
    const retried = makeCtx({
      turnId: "t-2b",
      sourceTurnId: "t-2",
      revealed: reminded,
    });
    expect((await handler(retried.ctx)).value.cue?.reminder).toBe(true);
    expect(retried.writes).toEqual([]);
    // Another turn does not.
    const later = makeCtx({ turnId: "t-3", revealed: reminded });
    expect((await handler(later.ctx)).value.cue).toBeNull();
  });

  it("fires planned events and lists only fired and planned events for planners", async () => {
    const debt = {
      id: "harbor-debt",
      title: "The Harbor Debt",
      when: { dimension: "location", equals: "harbor" },
      payload: "A debt collector waits by the bollards.",
      once: true,
      plannedTurn: 3,
    };
    const { ctx } = makeCtx({
      location: "harbor",
      planned: { [debt.id]: debt },
    });
    const result = await handler(ctx);
    expect(result.value.cue?.eventId).toBe("harbor-debt");
    expect(result.value.ledger).toEqual({
      turn: 5,
      revealed: [
        { eventId: "harbor-debt", title: "The Harbor Debt", lastTurn: 5 },
      ],
      planned: [],
    });
    // The pending authored event is never named to planners.
    expect(JSON.stringify(result.value.ledger)).not.toContain("lighthouse");
  });
});
