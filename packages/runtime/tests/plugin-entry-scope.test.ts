import { describe, expect, it, vi } from "vitest";
import { PluginEntryScope } from "../src/plugin-entry-scope.js";

describe("PluginEntryScope", () => {
  it("aborts, unpublishes, then awaits reverse resource cleanup exactly once", async () => {
    const scope = new PluginEntryScope();
    const order: string[] = [];
    const release = Promise.withResolvers<void>();
    scope.signal.addEventListener("abort", () => order.push("abort"));
    scope.onDispose(() => {
      order.push("first");
    });
    scope.onDispose(async () => {
      order.push("second:start");
      await release.promise;
      order.push("second:end");
    });
    scope.stage(() => scope.track(() => order.push("unregister")));
    scope.commit();
    const closing = scope.dispose();
    expect(scope.dispose()).toBe(closing);
    expect(order).toEqual(["abort", "unregister", "second:start"]);
    expect(() => scope.onDispose(() => {})).toThrow("registration is closed");
    release.resolve();
    await closing;
    expect(order).toEqual([
      "abort",
      "unregister",
      "second:start",
      "second:end",
      "first",
    ]);
    await scope.dispose();
    expect(order).toHaveLength(5);
  });

  it("releases resources acquired before a factory failed without publishing", async () => {
    const scope = new PluginEntryScope();
    const publish = vi.fn();
    const cleanup = vi.fn();
    scope.onDispose(cleanup);
    scope.stage(publish);
    const failure = new Error("initialization failed");
    await scope.dispose(failure);
    expect(scope.signal.reason).toBe(failure);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(() => scope.commit()).toThrow("registration is closed");
  });

  it("keeps cleaning resources after sync and async cleanup errors", async () => {
    const scope = new PluginEntryScope();
    const last = vi.fn();
    scope.onDispose(last);
    scope.onDispose(async () => {
      throw new Error("async cleanup");
    });
    scope.track(() => {
      throw new Error("unregister");
    });
    const error = await scope.dispose().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(last).toHaveBeenCalledOnce();
  });

  it("can cancel initialization before disposing and rejects malformed cleanup", async () => {
    const scope = new PluginEntryScope();
    expect(() => scope.onDispose(null as never)).toThrow("cleanup function");
    const cleanup = vi.fn();
    scope.onDispose(cleanup);
    scope.abort();
    expect(scope.signal.aborted).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    expect(() => scope.stage(() => {})).toThrow("registration is closed");
    await scope.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
