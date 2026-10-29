/**
 * The agent loop profile keys (`agent.loop.profile`, `stream`, `steering`,
 * `truncation`, `fallback`, `finalizer`) and their rules, on the authored
 * schema and on the compiled IR (`loopProfile`). Each rule is reported under
 * the path the format writes.
 */
import { describe, expect, it } from "vitest";
import { runtimeManifestInputSchema } from "../src/schemas/plugin.js";
import { runtimeAuthoringManifestSchema } from "../src/schemas/runtime-manifest.js";
import { LOOP_PRESETS } from "../src/schemas/runtime-defaults.js";

type Loop = Record<string, unknown>;

function authored(loop: Loop, visibility?: "story" | "system") {
  return {
    description: "Probe runtime",
    schedule: { stage: "narrative" },
    ...(visibility ? { io: { visibility } } : {}),
    agent: { loop },
  };
}

function compiled(
  loopProfile: Loop,
  outputKind: "story" | "system" = "system",
  timeoutMs = 120_000,
) {
  return {
    name: "probe",
    description: "Probe runtime",
    runtimeType: "agent",
    stage: "narrative",
    trigger: { type: "auto" },
    outputKind,
    timeoutMs,
    loopProfile,
  };
}

function issuePaths(
  result: ReturnType<typeof runtimeAuthoringManifestSchema.safeParse>,
) {
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

describe("authored agent.loop profile keys", () => {
  it.each<[string, Loop, "story" | "system" | undefined]>([
    [
      "a story with every key",
      {
        profile: "story",
        stream: true,
        steering: true,
        truncation: "accept",
        fallback: "answer-without-tools",
        finalizer: { maxSteps: false, deadlineReserveMs: 5_000 },
      },
      "story",
    ],
    [
      "a story that turns streaming off",
      { stream: false, truncation: "reject" },
      "story",
    ],
    ["an actor", { profile: "actor" }, undefined],
    [
      "a system agent that answers without tools",
      { fallback: "answer-without-tools" },
      "system",
    ],
    [
      "a reserve below the written limit",
      { timeoutMs: 60_000, finalizer: { deadlineReserveMs: 59_999 } },
      undefined,
    ],
  ])("accepts %s", (_name, loop, visibility) => {
    const result = runtimeAuthoringManifestSchema.safeParse(
      authored(loop, visibility),
    );
    expect(issuePaths(result)).toEqual([]);
  });

  it.each<[string, Loop, "story" | "system" | undefined, string]>([
    [
      "g1: profile story without visibility story",
      { profile: "story" },
      undefined,
      "agent.loop.profile",
    ],
    [
      "g2: stream on a system agent",
      { stream: true },
      "system",
      "agent.loop.stream",
    ],
    [
      "g2: steering on an actor",
      { profile: "actor", steering: true },
      undefined,
      "agent.loop.steering",
    ],
    [
      "g3: truncation accept without streaming",
      { truncation: "accept" },
      undefined,
      "agent.loop.truncation",
    ],
    [
      "g3: truncation accept on a story with stream off",
      { stream: false, truncation: "accept" },
      "story",
      "agent.loop.truncation",
    ],
    [
      "g3: a story with stream off that keeps the inherited truncation",
      { stream: false },
      "story",
      "agent.loop.stream",
    ],
    [
      "g3: a story profile with stream off and truncation omitted",
      { profile: "story", stream: false },
      "story",
      "agent.loop.stream",
    ],
    [
      "g4: a reserve not below the written limit",
      { timeoutMs: 60_000, finalizer: { deadlineReserveMs: 60_000 } },
      undefined,
      "agent.loop.finalizer.deadlineReserveMs",
    ],
    [
      "g4: a reserve not below the default limit",
      { finalizer: { deadlineReserveMs: 120_000 } },
      "system",
      "agent.loop.finalizer.deadlineReserveMs",
    ],
    [
      "g4: a negative reserve",
      { finalizer: { deadlineReserveMs: -1 } },
      undefined,
      "agent.loop.finalizer.deadlineReserveMs",
    ],
    [
      "g4: a fractional reserve",
      { finalizer: { deadlineReserveMs: 1.5 } },
      undefined,
      "agent.loop.finalizer.deadlineReserveMs",
    ],
    [
      "an unknown profile",
      { profile: "narrator" },
      undefined,
      "agent.loop.profile",
    ],
  ])("rejects %s", (_name, loop, visibility, path) => {
    const result = runtimeAuthoringManifestSchema.safeParse(
      authored(loop, visibility),
    );
    expect(issuePaths(result)).toContain(path);
  });

  it("reports a story preset on another runtime once", () => {
    const result = runtimeAuthoringManifestSchema.safeParse(
      authored({ profile: "story" }, "system"),
    );
    expect(issuePaths(result)).toEqual(["agent.loop.profile"]);
  });

  it("accepts a story reserve below its larger default limit", () => {
    const reserve = 200_000;
    expect(reserve).toBeGreaterThan(120_000);
    expect(
      runtimeAuthoringManifestSchema.safeParse(
        authored({ finalizer: { deadlineReserveMs: reserve } }, "story"),
      ).success,
    ).toBe(true);
  });
});

describe("compiled loopProfile", () => {
  it.each<[string, Loop, "story" | "system", number?]>([
    ["a story's overrides", { stream: false, truncation: "reject" }, "story"],
    ["an actor", { preset: "actor", fallback: "fail" }, "system"],
    [
      "a reserve below the limit",
      { finalizer: { deadlineReserveMs: 5_000 } },
      "system",
    ],
  ])("accepts %s", (_name, loopProfile, outputKind, timeoutMs) => {
    const result = runtimeManifestInputSchema.safeParse(
      compiled(loopProfile, outputKind, timeoutMs),
    );
    expect(issuePaths(result)).toEqual([]);
  });

  it.each<[string, Loop, "story" | "system", string, number?]>([
    [
      "g1: preset story on a system runtime",
      { preset: "story" },
      "system",
      "loopProfile.preset",
    ],
    [
      "g2: stream on a system runtime",
      { stream: true },
      "system",
      "loopProfile.stream",
    ],
    [
      "g2: steering on a system runtime",
      { steering: true },
      "system",
      "loopProfile.steering",
    ],
    [
      "g3: truncation accept on an actor",
      { preset: "actor", truncation: "accept" },
      "system",
      "loopProfile.truncation",
    ],
    [
      "g3: a story with stream off and truncation omitted",
      { stream: false },
      "story",
      "loopProfile.stream",
    ],
    [
      "g4: a reserve not below the limit",
      { finalizer: { deadlineReserveMs: 10_000 } },
      "system",
      "loopProfile.finalizer.deadlineReserveMs",
      10_000,
    ],
    ["a key the IR does not know", { profile: "actor" }, "system", ""],
  ])("rejects %s", (_name, loopProfile, outputKind, path, timeoutMs) => {
    const result = runtimeManifestInputSchema.safeParse(
      compiled(loopProfile, outputKind, timeoutMs),
    );
    expect(result.success).toBe(false);
    if (path) expect(issuePaths(result)).toContain(path);
  });
});

describe("LOOP_PRESETS", () => {
  it("streams, steers and keeps truncated text only in the story preset", () => {
    expect(LOOP_PRESETS.story).toMatchObject({
      stream: true,
      steering: true,
      truncation: "accept",
    });
    for (const preset of [LOOP_PRESETS.actor, LOOP_PRESETS.system])
      expect(preset).toMatchObject({
        stream: false,
        steering: false,
        truncation: "reject",
      });
    expect(LOOP_PRESETS.system.fallback).toBe("fail");
    expect(LOOP_PRESETS.actor.fallback).toBe("answer-without-tools");
  });
});

describe("correction budgets on authored and IR schemas", () => {
  const parsers = [
    (corrections: Loop) =>
      runtimeAuthoringManifestSchema.safeParse(authored({ corrections })),
    (corrections: Loop) =>
      runtimeManifestInputSchema.safeParse(compiled({ corrections })),
  ];
  it.each(["toolUse", "review", "loopPerturbation", "outputRepair"])(
    "accepts only integer budgets in range for %s",
    (key) => {
      const maximum = key === "review" ? 5 : 3;
      for (const parse of parsers) {
        for (const value of [0, 1, maximum]) {
          const result = parse({ [key]: value });
          expect(result.success).toBe(true);
        }
        for (const value of [-1, maximum + 1, 0.5, "1", null]) {
          const result = parse({ [key]: value });
          expect(result.success).toBe(false);
          if (!result.success)
            expect(result.error.issues[0]?.path.at(-1)).toBe(key);
        }
      }
    },
  );
  it("keeps optional keys absent and rejects unknown keys", () => {
    for (const parse of parsers) {
      expect(parse({}).success).toBe(true);
      expect(parse({ typo: 1 }).success).toBe(false);
    }
    const authoredResult = runtimeAuthoringManifestSchema.parse(
      authored({ corrections: { review: 0 } }),
    );
    expect(authoredResult.agent?.loop?.corrections).toEqual({ review: 0 });
    const ir = runtimeManifestInputSchema.parse(
      compiled({ corrections: { review: 0 } }),
    );
    expect(ir.loopProfile?.corrections).toEqual({ review: 0 });
  });
});
