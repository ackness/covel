import { describe, expect, it, vi } from "vitest";
import { director } from "../lib/director.js";
import { chooseActors } from "../lib/policies.js";
import { context, input } from "./fixture.js";
const advice = { order: "sequential", narrator: "after", yieldHint: "user" };
describe("director projection", () => {
  it("propagates model failure after a usable slot is found", async () => {
    const error = new Error("Model request failed");
    await expect(
      chooseActors(
        input(),
        context(
          { strategy: "director" },
          {
            gateway: {
              resolveSlot: () => ({ presetId: "plugin" }),
              generateObject: async () => {
                throw error;
              },
            },
          },
        ),
        "turn-policy",
      ),
    ).rejects.toBe(error);
  });
  it("does not publish a model answer that arrives after cancellation", async () => {
    const controller = new AbortController();
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const result = director(
      input(),
      context(
        {},
        {
          signal: controller.signal,
          gateway: {
            resolveSlot: () => ({ presetId: "plugin" }),
            generateObject: async ({ signal }) => {
              expect(signal).toBe(controller.signal);
              entered();
              return pending;
            },
          },
        },
      ),
    );
    const rejected = expect(result).rejects.toThrow();
    await started;
    controller.abort();
    finish({ object: { ...advice, actors: [{ character: "Mara" }] } });
    await rejected;
  });
  it("projects names and public context and resolves model output only afterwards", async () => {
    const generateObject = vi.fn(async () => ({
      object: {
        ...advice,
        actors: [{ character: "Captain", instruction: "Greet the visitor." }],
      },
    }));
    const ctx = context(
      { strategy: "director" },
      {
        locale: "zh-CN",
        gateway: {
          resolveSlot: () => ({ presetId: "plugin" }),
          generateObject,
        },
      },
    );
    const plan = await director(
      input({
        actions: [
          {
            kind: "direct",
            source: "player",
            seatId: "seat-secret",
            actorId: "actor-secret",
            text: "Welcome the visitor.",
            fields: { secret: "field-secret" },
          },
        ],
      }),
      ctx,
    );
    expect(plan.actors).toEqual([
      { characterId: "mara", instruction: "Greet the visitor." },
    ]);
    expect(generateObject).toHaveBeenCalledOnce();
    const request = generateObject.mock.calls[0][0];
    expect(request.signal).toBe(ctx.signal);
    expect(request.system).toContain("会话内容语言");
    expect(request.prompt).toContain("Mara");
    for (const secret of [
      "seat-secret",
      "actor-secret",
      "field-secret",
      "characterId",
      '"mara"',
    ])
      expect(request.prompt).not.toContain(secret);
  });
  it.each([
    [{ character: "Nobody" }],
    [{ character: "Mara" }, { character: "Captain" }],
  ])("rejects invented or repeated actors", async (actors) => {
    await expect(
      director(
        input(),
        context(
          {},
          {
            gateway: {
              resolveSlot: () => ({}),
              generateObject: async () => ({ object: { ...advice, actors } }),
            },
          },
        ),
      ),
    ).rejects.toThrow();
  });
  it("does not call an absent slot, uses mention without a gateway, and propagates abort", async () => {
    const generateObject = vi.fn();
    await expect(
      director(
        input(),
        context(
          {},
          { gateway: { resolveSlot: () => undefined, generateObject } },
        ),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(generateObject).not.toHaveBeenCalled();
    for (const resolveSlot of [
      () => null,
      () => {
        throw new Error("No default preset");
      },
    ]) {
      expect(
        await chooseActors(
          input({ actions: [{ text: "Mara" }] }),
          context(
            { strategy: "director" },
            { gateway: { resolveSlot, generateObject } },
          ),
          "turn-policy",
        ),
      ).toMatchObject({
        actors: [
          {
            characterId: "mara",
            reason: "Director unavailable; mention strategy used.",
          },
        ],
        yieldHint: "user",
      });
    }
    expect(
      (
        await chooseActors(
          input({ actions: [{ text: "Mara" }] }),
          context({ strategy: "director" }),
          "turn-policy",
        )
      ).actors,
    ).toEqual([
      {
        characterId: "mara",
        reason: "Director unavailable; mention strategy used.",
      },
    ]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      director(
        input(),
        context(
          {},
          {
            signal: controller.signal,
            gateway: { resolveSlot: () => ({}), generateObject },
          },
        ),
      ),
    ).rejects.toThrow();
    expect(generateObject).not.toHaveBeenCalled();
  });
});
