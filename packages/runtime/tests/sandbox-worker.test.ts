import { describe, expect, it } from "vitest";
import { runSandboxWorker, SandboxWorkerError } from "../src/index.js";

describe("Tier 1 sandbox compute worker", () => {
  it("executes pure RPG rule calculations and returns frozen JSON results", async () => {
    const result = await runSandboxWorker<
      { rolls: number[]; dc: number },
      { total: number; passed: boolean; frozenBlocked: boolean }
    >({
      input: { rolls: [6, 5, 4], dc: 12 },
      code: `
        let frozenBlocked = false;
        try {
          input.rolls.push(99);
        } catch {
          frozenBlocked = true;
        }
        const total = input.rolls.reduce((sum, n) => sum + n, 0);
        return { total, passed: total >= input.dc, frozenBlocked };
      `,
    });

    expect(result).toEqual({
      total: 15,
      passed: true,
      frozenBlocked: true,
    });
  });

  it("terminates infinite loops promptly with timeout error code", async () => {
    const promise = runSandboxWorker({
      input: {},
      timeoutMs: 80,
      code: `while (true) {}`,
    });

    await expect(promise).rejects.toMatchObject({
      name: "SandboxWorkerError",
      code: "timeout",
    } satisfies Partial<SandboxWorkerError>);
  });

  it.each([
    ["process", "return typeof process;"],
    ["require", "return typeof require;"],
    ["fetch", "return typeof fetch;"],
    ["Function", 'return Function("return process")();'],
    ["eval", 'return eval("1 + 1");'],
  ])("blocks host/code-generation primitive %s", async (_name, code) => {
    if (code.startsWith("return typeof")) {
      const res = await runSandboxWorker<unknown, string>({
        input: {},
        code,
      });
      expect(res).toBe("undefined");
    } else {
      await expect(
        runSandboxWorker({ input: {}, code }),
      ).rejects.toBeInstanceOf(SandboxWorkerError);
    }
  });

  it("rejects outputs exceeding maxOutputBytes", async () => {
    await expect(
      runSandboxWorker({
        input: { size: 512 },
        maxOutputBytes: 64,
        code: `return { text: "a".repeat(input.size) };`,
      }),
    ).rejects.toMatchObject({
      code: "output_too_large",
    });
  });

  it("aborts immediately when AbortSignal is triggered", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSandboxWorker({
        input: {},
        signal: controller.signal,
        code: `return { ok: true };`,
      }),
    ).rejects.toMatchObject({
      code: "aborted",
    });
  });
});
