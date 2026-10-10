import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentTraceRetention,
  setTraceRetentionPlayerSource,
} from "@covel/shared";
import {
  installTraceRetentionSource,
  traceRetentionInfo,
} from "../../src/lib/trace-retention-source.js";

const ENV_KEYS = [
  "COVEL_HOME",
  "COVEL_DESKTOP_REST",
  "COVEL_TRACE_RETENTION_DAYS",
  "DEPLOYMENT_TIER",
] as const;

describe("trace retention from the desktop settings file", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  function writeSettings(value: unknown, revision = 1): void {
    fs.writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        revision,
        savedAt: "2026-10-10T00:00:00Z",
        entries: { "diagnostics.traceRetention": value },
      }),
    );
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    home = fs.mkdtempSync(path.join(os.tmpdir(), "covel-retention-"));
    process.env.COVEL_HOME = home;
    process.env.COVEL_DESKTOP_REST = "1";
    installTraceRetentionSource();
  });

  afterEach(() => {
    setTraceRetentionPlayerSource(undefined);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads the player's choice and sees a later change of the file", () => {
    expect(currentTraceRetention()).toEqual({ days: 30, source: "default" });
    writeSettings("7");
    expect(currentTraceRetention()).toEqual({ days: 7, source: "setting" });
    writeSettings("keep", 2);
    expect(currentTraceRetention()).toEqual({ days: 0, source: "setting" });
    expect(traceRetentionInfo()).toEqual({
      days: 0,
      source: "setting",
      settable: true,
    });
  });

  it("ignores a stored value that is not one of the choices", () => {
    writeSettings("12");
    expect(currentTraceRetention().source).toBe("default");
  });

  it("lets the operator's variable win and reports the field as fixed", () => {
    writeSettings("7");
    process.env.COVEL_TRACE_RETENTION_DAYS = "14";
    expect(traceRetentionInfo()).toEqual({
      days: 14,
      source: "env",
      settable: false,
    });
  });

  it("is not settable on a hosted tier, and the file is not read", () => {
    writeSettings("keep");
    process.env.DEPLOYMENT_TIER = "demo";
    expect(traceRetentionInfo()).toEqual({
      days: 30,
      source: "default",
      settable: false,
    });
  });

  it("is not settable without the desktop shell", () => {
    writeSettings("keep");
    delete process.env.COVEL_DESKTOP_REST;
    expect(traceRetentionInfo()).toMatchObject({
      days: 30,
      settable: false,
    });
  });
});
