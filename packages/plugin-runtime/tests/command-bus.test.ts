import { describe, it, expect, vi } from "vitest";
import {
  createCommandRegistry,
  createCommandBus,
  CommandError,
} from "../src/index.js";

function makeRegistry() {
  const registry = createCommandRegistry();
  return registry;
}

describe("command bus", () => {
  it("dispatches a simple command to the correct handler", async () => {
    const registry = makeRegistry();
    const handler = vi.fn().mockResolvedValue({ content: "pong" });
    registry.register({
      name: "ping",
      pluginId: "core",
      description: "Ping",
      handler,
    });

    const bus = createCommandBus(registry);
    const result = await bus.dispatch("/ping");

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: "pong" });
  });

  it("passes parsed args and context to handler", async () => {
    const registry = makeRegistry();
    const handler = vi.fn().mockResolvedValue({});
    registry.register({
      name: "guide",
      pluginId: "core",
      description: "Guide",
      handler,
    });

    const bus = createCommandBus(registry);
    await bus.dispatch("/guide combat --verbose", {
      sessionId: "s1",
      locale: "zh-CN",
    });

    const [args, ctx] = handler.mock.calls[0];
    expect(args._).toEqual(["combat"]);
    expect(args.verbose).toBe(true);
    expect(ctx.sessionId).toBe("s1");
    expect(ctx.locale).toBe("zh-CN");
  });

  it("validates args with schema and rejects invalid input", async () => {
    const registry = makeRegistry();
    registry.register({
      name: "strict",
      pluginId: "core",
      description: "Strict command",
      handler: async () => ({}),
      argsSchema: {
        safeParse(data: unknown) {
          const args = data as { _: string[] };
          if (args._.length === 0) {
            return {
              success: false as const,
              error: {
                issues: [{ path: ["_"], message: "At least one positional argument required" }],
              },
            };
          }
          return { success: true as const, data: args };
        },
      },
    });

    const bus = createCommandBus(registry);

    // No positional args → validation fails
    await expect(bus.dispatch("/strict")).rejects.toThrow(CommandError);

    // With positional args → passes
    const result = await bus.dispatch("/strict hello");
    expect(result).toEqual({});
  });

  it("throws COMMAND_NOT_FOUND for unknown commands", async () => {
    const registry = makeRegistry();
    const bus = createCommandBus(registry);

    try {
      await bus.dispatch("/unknown");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CommandError);
      expect((err as CommandError).code).toBe("COMMAND_NOT_FOUND");
    }
  });

  it("throws ARGUMENT_VALIDATION_FAILED with issues", async () => {
    const registry = makeRegistry();
    registry.register({
      name: "val",
      pluginId: "core",
      description: "Validation test",
      handler: async () => ({}),
      argsSchema: {
        safeParse() {
          return {
            success: false as const,
            error: {
              issues: [
                { path: ["limit"], message: "Expected number" },
                { path: ["_", "0"], message: "Required" },
              ],
            },
          };
        },
      },
    });

    const bus = createCommandBus(registry);

    try {
      await bus.dispatch("/val");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CommandError);
      const cmdErr = err as CommandError;
      expect(cmdErr.code).toBe("ARGUMENT_VALIDATION_FAILED");
      expect(cmdErr.issues).toHaveLength(2);
      expect(cmdErr.issues![0].path).toBe("limit");
      expect(cmdErr.issues![1].path).toBe("_.0");
    }
  });

  it("skips validation when no argsSchema", async () => {
    const registry = makeRegistry();
    const handler = vi.fn().mockResolvedValue("ok");
    registry.register({
      name: "loose",
      pluginId: "core",
      description: "No schema",
      handler,
    });

    const bus = createCommandBus(registry);
    const result = await bus.dispatch("/loose anything --flag");

    expect(result).toBe("ok");
    expect(handler.mock.calls[0][0]._).toEqual(["anything"]);
    expect(handler.mock.calls[0][0].flag).toBe(true);
  });
});
