import { afterEach, describe, expect, it } from "vitest";
import {
  currentTraceRetention,
  resolveTraceRetention,
  setTraceRetentionPlayerSource,
  traceRetentionDaysFromSetting,
} from "../src/env/trace-retention.js";

describe("resolveTraceRetention", () => {
  it("defaults to 30 days", () => {
    expect(resolveTraceRetention(undefined, {})).toEqual({
      days: 30,
      source: "default",
    });
  });

  it("uses the player's choice when the operator set none", () => {
    expect(resolveTraceRetention(90, {})).toEqual({
      days: 90,
      source: "setting",
    });
    expect(resolveTraceRetention(0, {})).toEqual({
      days: 0,
      source: "setting",
    });
  });

  it("lets the operator's variable win, 0 included", () => {
    const env = { COVEL_TRACE_RETENTION_DAYS: "0" };
    expect(resolveTraceRetention(7, env)).toEqual({ days: 0, source: "env" });
    expect(
      resolveTraceRetention(7, { COVEL_TRACE_RETENTION_DAYS: "14" }),
    ).toEqual({ days: 14, source: "env" });
  });

  it("ignores an unusable variable", () => {
    expect(
      resolveTraceRetention(7, { COVEL_TRACE_RETENTION_DAYS: "-3" }),
    ).toEqual({ days: 7, source: "setting" });
    expect(
      resolveTraceRetention(undefined, { COVEL_TRACE_RETENTION_DAYS: "soon" }),
    ).toEqual({ days: 30, source: "default" });
  });

  it("never applies the player's choice on a hosted tier", () => {
    for (const tier of ["demo", "commercial"]) {
      expect(resolveTraceRetention(0, { DEPLOYMENT_TIER: tier })).toEqual({
        days: 30,
        source: "default",
      });
    }
  });
});

describe("traceRetentionDaysFromSetting", () => {
  it("maps the stored choices to days and rejects anything else", () => {
    expect(traceRetentionDaysFromSetting("7")).toBe(7);
    expect(traceRetentionDaysFromSetting("keep")).toBe(0);
    expect(traceRetentionDaysFromSetting("12")).toBeUndefined();
    expect(traceRetentionDaysFromSetting(30)).toBeUndefined();
  });
});

describe("currentTraceRetention", () => {
  afterEach(() => setTraceRetentionPlayerSource(undefined));

  it("falls back when the player source throws", () => {
    setTraceRetentionPlayerSource(() => {
      throw new Error("unreadable");
    });
    expect(currentTraceRetention().days).toBe(30);
  });
});
