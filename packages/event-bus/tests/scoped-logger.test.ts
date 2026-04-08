import { describe, it, expect, vi } from "vitest";
import { createScopedLogger } from "../src/scoped-logger.js";
import type { LogEntry, LogSink } from "../src/scoped-logger.js";

function createTestSink(): LogSink & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    write(entry: LogEntry) {
      entries.push(entry);
    },
  };
}

describe("ScopedLogger", () => {
  it("should log with correct level", () => {
    const sink = createTestSink();
    const logger = createScopedLogger({ pluginId: "test" }, sink);

    logger.info("hello");
    logger.warn("careful");
    logger.error("boom", new Error("err"));
    logger.debug("detail");

    expect(sink.entries).toHaveLength(4);
    expect(sink.entries[0].level).toBe("info");
    expect(sink.entries[1].level).toBe("warn");
    expect(sink.entries[2].level).toBe("error");
    expect(sink.entries[3].level).toBe("debug");
  });

  it("should include fields in log entries", () => {
    const sink = createTestSink();
    const logger = createScopedLogger(
      { pluginId: "core-dice", runtimeId: "dice-roll" },
      sink,
    );

    logger.info("rolled");

    expect(sink.entries[0].fields.pluginId).toBe("core-dice");
    expect(sink.entries[0].fields.runtimeId).toBe("dice-roll");
  });

  it("should merge extra data into fields", () => {
    const sink = createTestSink();
    const logger = createScopedLogger({ pluginId: "test" }, sink);

    logger.info("msg", { extra: 42 });

    expect(sink.entries[0].fields.extra).toBe(42);
  });

  it("should create child logger with inherited fields", () => {
    const sink = createTestSink();
    const parent = createScopedLogger({ pluginId: "test" }, sink);
    const child = parent.child({ sessionId: "s1", turnId: "t1" });

    child.info("child message");

    expect(sink.entries[0].fields.pluginId).toBe("test");
    expect(sink.entries[0].fields.sessionId).toBe("s1");
    expect(sink.entries[0].fields.turnId).toBe("t1");
  });

  it("should capture error object in error level", () => {
    const sink = createTestSink();
    const logger = createScopedLogger({ pluginId: "test" }, sink);
    const err = new Error("test error");

    logger.error("something failed", err);

    expect(sink.entries[0].error).toBe(err);
    expect(sink.entries[0].message).toBe("something failed");
  });

  it("should include timestamp", () => {
    const sink = createTestSink();
    const logger = createScopedLogger({ pluginId: "test" }, sink);

    logger.info("msg");

    expect(sink.entries[0].timestamp).toBeDefined();
    expect(typeof sink.entries[0].timestamp).toBe("string");
  });
});
