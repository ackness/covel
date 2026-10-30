import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "../runtimes/check/handler.js";

afterEach(() => vi.unstubAllEnvs());

function context(locale) {
  return {
    locale,
    turnId: "turn-1",
    pluginId: "tabletop-rules",
    inputs: {
      rules: { value: { attributes: [{ id: "combat", base: 1, max: 5 }] } },
    },
    world: {
      characters: [{ id: "player", type: "player", fields: {} }],
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
    },
    tools: {
      call: vi.fn(async () => {
        throw new Error("Unexpected tool call");
      }),
    },
    pluginData: { get: async () => null, set: async () => {} },
    store: { listPlayerInputs: async () => [] },
  };
}

describe("check instructions", () => {
  it("follow the instruction language, not the session language", async () => {
    expect((await handler(context("zh-CN"))).value.checkContext).toBe(
      "No tabletop check submitted（本回合没有提交跑团检定，不要编造掷骰）",
    );
    expect((await handler(context("ru-RU"))).value.checkContext).toBe(
      "No tabletop check submitted. Do not invent a roll.",
    );
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "en");
    expect((await handler(context("zh-CN"))).value.checkContext).toBe(
      "No tabletop check submitted. Do not invent a roll.",
    );
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "zh");
    expect((await handler(context("en-US"))).value.checkContext).toBe(
      "No tabletop check submitted（本回合没有提交跑团检定，不要编造掷骰）",
    );
  });
});

it("settles the check for the action's actor without a character tool lookup", async () => {
  const ctx = context("en-US");
  ctx.world.characters = [
    { id: "first", type: "player", fields: { combat: 1 } },
    { id: "second", type: "player", fields: { combat: 4 } },
  ];
  ctx.world.characterSchema = {
    attributes: [{ id: "combat", type: "number", min: 0, max: 5 }],
  };
  ctx.playerActions = [
    { seatId: "main", kind: "act", source: "player", actorId: "second" },
  ];
  ctx.store.listPlayerInputs = async () => [
    {
      id: "answer",
      formId: "tabletop-rules-check-turn",
      values: {
        attribute: "combat",
        difficulty: "12",
        action: "Open the gate",
      },
    },
  ];
  ctx.random = { int: () => 10 };
  const result = await handler(ctx);
  expect(result.value.receipt).toMatchObject({
    characterId: "second",
    score: 4,
    modifier: 8,
  });
  expect(ctx.tools.call).not.toHaveBeenCalled();
});

it("requires a bound character before rolling", async () => {
  const ctx = context("en-US");
  ctx.world.seats = [];
  await expect(handler(ctx)).rejects.toThrow(
    "Create a player character before rolling",
  );
  expect(ctx.tools.call).not.toHaveBeenCalled();
});
