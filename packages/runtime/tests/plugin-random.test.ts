import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginRandom,
  restartSessionRandom,
} from "../src/function-runtime/plugin-random.js";
import { createToolExecutionContext } from "../src/agent-loop/tool-execution-context.js";

const draw = (
  sessionId: string,
  stream: string,
  count: number,
  pluginId = "dice",
) => {
  const random = createPluginRandom({ sessionId, pluginId, stream });
  return Array.from({ length: count }, () => random.int(1, 21));
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const id of ["run", "other", "tool"]) restartSessionRandom(id);
});

describe("ctx.random", () => {
  it("draws within the range when the server has no seed", () => {
    vi.stubEnv("COVEL_RANDOM_SEED", "");
    for (const value of draw("run", "dice/roller", 200)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(20);
    }
  });

  it("repeats the draws of a session when the session is created again", () => {
    vi.stubEnv("COVEL_RANDOM_SEED", "seed-a");
    const first = draw("run", "dice/roller", 12);
    // One context after another continues the stream; it does not repeat it.
    expect(draw("run", "dice/roller", 12)).not.toEqual(first);

    restartSessionRandom("run");
    expect(draw("run", "dice/roller", 12)).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(3);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(20);
    }
  });

  it("keeps one stream's numbers when another stream draws in between", () => {
    vi.stubEnv("COVEL_RANDOM_SEED", "seed-a");
    const alone = draw("run", "dice/roller", 6);

    restartSessionRandom("run");
    const roller = createPluginRandom({
      sessionId: "run",
      pluginId: "dice",
      stream: "dice/roller",
    });
    const interleaved: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      draw("run", "rpc:roll", 2);
      draw("run", "dice/roller", 1, "another-plugin");
      interleaved.push(roller.int(1, 21));
    }
    expect(interleaved).toEqual(alone);
  });

  it("gives every session the same numbers, and another seed other numbers", () => {
    vi.stubEnv("COVEL_RANDOM_SEED", "seed-a");
    const first = draw("run", "dice/roller", 12);
    expect(draw("other", "dice/roller", 12)).toEqual(first);
    // Starting one session again leaves the other where it was.
    restartSessionRandom("run");
    expect(draw("other", "dice/roller", 12)).not.toEqual(first);

    vi.stubEnv("COVEL_RANDOM_SEED", "seed-b");
    restartSessionRandom("run");
    expect(draw("run", "dice/roller", 12)).not.toEqual(first);
  });

  it("rejects a range that randomInt of node:crypto rejects", () => {
    vi.stubEnv("COVEL_RANDOM_SEED", "seed-a");
    const random = createPluginRandom({
      sessionId: "run",
      pluginId: "dice",
      stream: "dice/roller",
    });
    expect(() => random.int(5, 5)).toThrow(RangeError);
    expect(() => random.int(0.5, 3)).toThrow(RangeError);
  });

  it("is on the context of every tool call, on the calling runtime's stream", () => {
    vi.stubEnv("COVEL_RANDOM_SEED", "seed-a");
    const caller = {
      sessionId: "tool",
      turnId: "turn-1",
      pluginId: "dice",
      runtimeId: "dice/roller",
    };
    const fromTool = createToolExecutionContext(caller, undefined).context
      .random!;
    const values = [fromTool.int(1, 21), fromTool.int(1, 21)];

    restartSessionRandom("tool");
    expect(draw("tool", "dice/roller", 2)).toEqual(values);
  });
});
