import { expect, it, vi } from "vitest";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { createPluginRpcRegistry } from "../src/rpc/rpc-registry.js";

it("disposes only the registered hook instance even when ids are reused", async () => {
  const pipeline = createHookPipeline();
  const first = vi.fn(async () => ({ action: "continue" as const }));
  const next = vi.fn(async () => ({ action: "continue" as const }));
  const dispose = pipeline.register({
    id: "shared-id",
    event: "TurnStart",
    handler: first,
  });
  pipeline.register({ id: "shared-id", event: "TurnStart", handler: next });
  dispose();
  dispose();
  await pipeline.run(
    "TurnStart",
    { event: "TurnStart", sessionId: "s1", turnId: "t1" },
    {},
  );
  expect(first).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
});

it("an old RPC disposer cannot remove a new registration at the same key", () => {
  const registry = createPluginRpcRegistry();
  const handler = async () => true;
  const dispose = registry.registerPluginHandler(
    "fixture",
    "action",
    handler,
    {},
    "builtin",
  );
  dispose();
  const next = registry.registerPluginHandler(
    "fixture",
    "action",
    handler,
    {},
    "builtin",
  );
  dispose();
  expect(registry.getPluginAction("fixture", "action")?.handler).toBe(handler);
  next();
  expect(registry.getPluginAction("fixture", "action")).toBeUndefined();
});
