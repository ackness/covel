import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { createRootOperationStage } from "../src/operations/operation-stage.js";

const SESSION = "sess-mutex";
const TURN = "turn-mutex";
const open: DataStore[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((store) => store.close()));
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFixture() {
  const store = createMemoryStore();
  open.push(store);
  const registry = new PluginServiceRegistry({
    list: async () => ["bank", "shop"],
    ensure: async () => {},
  });
  const root = createRootOperationStage({
    caller: { pluginId: "shop", runtimeId: "shop/trade", runId: "run-1" },
    sessionId: SESSION,
    turnId: TURN,
  });
  const makeClient = (stage = root.child()) =>
    registry.createClient({
      sessionId: SESSION,
      turnId: TURN,
      pluginId: "shop",
      runtimeId: "shop/trade",
      signal: new AbortController().signal,
      reads: { store, locale: "en-US" },
      operations: stage,
    });
  return { store, registry, root, makeClient };
}

describe("write-service mutex lifetime on timeout and abort", () => {
  it.each(["timeout", "abort", "timeout-then-reject"] as const)(
    "keeps stage.lock held until a non-cooperative handler settles (%s)",
    async (mode) => {
      const { registry, root, makeClient } = makeFixture();
      const events: string[] = [];
      let active = 0;
      let maxConcurrent = 0;
      let calls = 0;
      const call1Entered = deferred();
      const releaseCall1 = deferred();

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        registry.register("bank", {
          name: "mutate",
          contract: "bank.mutate@1",
          access: "write",
          input: z.object({ label: z.string() }),
          output: z.object({ label: z.string() }),
          handler: async ({ label }, ctx) => {
            const index = ++calls;
            active++;
            maxConcurrent = Math.max(maxConcurrent, active);
            events.push(`enter-${index}:${label}`);
            try {
              if (index === 1) {
                call1Entered.resolve();
                // Non-cooperative: intentionally ignores ctx.signal.
                await releaseCall1.promise;
                if (mode === "timeout-then-reject") {
                  throw new Error("late handler rejection after timeout");
                }
              } else {
                await ctx.pluginData.set("ledger", label, index);
              }
              return { label };
            } finally {
              events.push(`exit-${index}:${label}`);
              active--;
            }
          },
        });

        const abortController = new AbortController();
        const call1 = makeClient(root.child()).call(
          {
            pluginId: "bank",
            name: "mutate",
            contract: "bank.mutate@1",
            input: { label: "first" },
          },
          mode === "abort"
            ? { signal: abortController.signal }
            : { timeoutMs: 20 },
        );

        await call1Entered.promise;
        if (mode === "abort") {
          abortController.abort(new Error("caller aborted"));
        }

        await expect(call1).rejects.toThrow();

        // Start call #2 while call #1's handler is still running.
        const stage2 = root.child();
        const call2 = makeClient(stage2).call({
          pluginId: "bank",
          name: "mutate",
          contract: "bank.mutate@1",
          input: { label: "second" },
        });

        // Give the event loop enough ticks for call #2 to enter if the lock was prematurely released.
        await new Promise((resolve) => setTimeout(resolve, 35));
        expect(events).toEqual(["enter-1:first"]);
        expect(active).toBe(1);
        expect(maxConcurrent).toBe(1);

        // Now let call #1's handler finish; call #2 must run strictly afterwards.
        releaseCall1.resolve();
        expect(await call2).toEqual({ label: "second" });
        stage2.commit();

        expect(maxConcurrent).toBe(1);
        expect(events).toEqual([
          "enter-1:first",
          "exit-1:first",
          "enter-2:second",
          "exit-2:second",
        ]);
        expect(root.held()).toHaveLength(1);
        expect(root.held()[0]?.request).toEqual({ label: "second" });

        // Flush microtasks to verify no unhandled rejection from late handler failure.
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );
});
