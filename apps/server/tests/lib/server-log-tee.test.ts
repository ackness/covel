import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyServerStreamLine,
  resetServerLogFileForTests,
  setupServerLogFile,
} from "../../src/server-log-tee.js";

describe("classifyServerStreamLine", () => {
  it("preserves explicitly marked stderr warnings as warn", () => {
    expect(
      classifyServerStreamLine(
        "stderr",
        "[covel:warn] [runtime-retry] narrator attempt=1",
      ),
    ).toEqual({
      level: "warn",
      message: "[runtime-retry] narrator attempt=1",
    });
  });

  it("keeps unmarked stderr as error and stdout as info", () => {
    expect(classifyServerStreamLine("stderr", "fatal").level).toBe("error");
    expect(classifyServerStreamLine("stdout", "ready").level).toBe("info");
  });
});

describe("setupServerLogFile resilience", () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetServerLogFileForTests();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not recurse when log rotation fails and detaches the channel", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "covel-log-tee-"));
    dirs.push(dir);
    const logPath = path.join(dir, "server.log");
    // Pre-seed files so the very first write exceeds the 1 MiB threshold and
    // triggers unlinkSync on the oldest backup.
    writeFileSync(logPath, Buffer.alloc(1024 * 1024, 0x61));
    writeFileSync(`${logPath}.1`, "old backup");

    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as NodeJS.WriteStream["write"];

    try {
      setupServerLogFile({
        filePath: logPath,
        rotation: { maxSizeMb: 1, maxFiles: 2 },
      });

      const unlinkSpy = vi
        .spyOn(fs, "unlinkSync")
        .mockImplementation(() => {
          throw new Error("EBUSY: simulated rotation lock");
        });

      expect(() => {
        process.stderr.write("trigger rotation\n");
        process.stderr.write("subsequent write after detach\n");
      }).not.toThrow();

      expect(unlinkSpy).toHaveBeenCalledTimes(1);
      expect(
        stderrChunks.some((chunk) =>
          chunk.includes("[server-log-tee] rotation failed"),
        ),
      ).toBe(true);
    } finally {
      resetServerLogFileForTests();
      process.stderr.write = origStderrWrite;
    }
  });

  it("handles asynchronous WriteStream errors without crashing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "covel-log-tee-err-"));
    dirs.push(dir);
    const logPath = path.join(dir, "server.log");

    let capturedStream: fs.WriteStream | undefined;
    const realCreate = fs.createWriteStream.bind(fs);
    vi.spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = realCreate(...args);
      capturedStream = stream;
      return stream;
    });

    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as NodeJS.WriteStream["write"];

    try {
      setupServerLogFile({ filePath: logPath });
      expect(capturedStream).toBeDefined();
      expect(() => {
        capturedStream!.emit("error", new Error("ENOSPC: disk full"));
        process.stdout.write("safe after stream error\n");
      }).not.toThrow();
      expect(
        stderrChunks.some((chunk) =>
          chunk.includes("[server-log-tee] stream error"),
        ),
      ).toBe(true);
    } finally {
      resetServerLogFileForTests();
      process.stderr.write = origStderrWrite;
    }
  });
});
