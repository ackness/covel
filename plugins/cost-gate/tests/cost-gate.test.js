import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import accumulateUsage from "../hooks/accumulate-usage.js";
import trimDownstream from "../hooks/trim-downstream.js";
import enforceCap from "../hooks/enforce-cap.js";
import cleanup from "../hooks/cleanup.js";
import { total, resolveLimits, _reset } from "../hooks/budget.js";

const SID = "sess-cost-1";

describe("cost-gate hooks", () => {
  const prevHard = process.env.COST_GATE_HARD_TOKENS;
  const prevSoft = process.env.COST_GATE_SOFT_TOKENS;

  beforeEach(() => {
    _reset();
    process.env.COST_GATE_HARD_TOKENS = "100";
    process.env.COST_GATE_SOFT_TOKENS = "50";
  });

  afterEach(() => {
    if (prevHard === undefined) delete process.env.COST_GATE_HARD_TOKENS;
    else process.env.COST_GATE_HARD_TOKENS = prevHard;
    if (prevSoft === undefined) delete process.env.COST_GATE_SOFT_TOKENS;
    else process.env.COST_GATE_SOFT_TOKENS = prevSoft;
    _reset();
  });

  it("accumulate-usage adds token usage into the session bucket", async () => {
    const r = await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 10, outputTokens: 5 } } },
    );
    expect(r).toEqual({ action: "continue" });
    expect(total(SID)).toBe(15);

    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 20, outputTokens: 0 } } },
    );
    expect(total(SID)).toBe(35);
  });

  it("accumulate-usage is a no-op when usage is missing", async () => {
    await accumulateUsage({ sessionId: SID }, { response: {} });
    await accumulateUsage({ sessionId: SID }, {});
    expect(total(SID)).toBe(0);
  });

  it("trim-downstream keeps all runtimes below the soft cap", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 10, outputTokens: 0 } } },
    ); // 10 < 50
    const triggered = [
      { name: "narrator", outputKind: "story" },
      { name: "codex", outputKind: "plugin" },
    ];
    const r = await trimDownstream({ sessionId: SID }, { triggered });
    expect(r).toEqual({ action: "continue" });
  });

  it("trim-downstream drops non-story runtimes at/above the soft cap", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 60, outputTokens: 0 } } },
    ); // 60 >= 50
    const triggered = [
      { name: "narrator", outputKind: "story" },
      { name: "codex", outputKind: "plugin" },
      { name: "guide", outputKind: "plugin" },
    ];
    const r = await trimDownstream({ sessionId: SID }, { triggered });
    expect(r.action).toBe("continue");
    expect(r.replace.triggered).toEqual([
      { name: "narrator", outputKind: "story" },
    ]);
  });

  it("trim-downstream returns plain continue when there is nothing to drop", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 60, outputTokens: 0 } } },
    );
    const triggered = [{ name: "narrator", outputKind: "story" }];
    const r = await trimDownstream({ sessionId: SID }, { triggered });
    expect(r).toEqual({ action: "continue" });
  });

  it("enforce-cap aborts the turn at/above the hard cap", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 100, outputTokens: 0 } } },
    ); // 100 >= 100
    const r = await enforceCap({ sessionId: SID });
    expect(r.action).toBe("abort");
    expect(r.reason).toMatch(/budget/i);
  });

  it("enforce-cap continues below the hard cap", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 99, outputTokens: 0 } } },
    );
    const r = await enforceCap({ sessionId: SID });
    expect(r).toEqual({ action: "continue" });
  });

  it("cleanup drops the session bucket", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 30, outputTokens: 0 } } },
    );
    expect(total(SID)).toBe(30);
    const r = await cleanup({ sessionId: SID });
    expect(r).toEqual({ action: "continue" });
    expect(total(SID)).toBe(0);
  });

  it("buckets are isolated per session", async () => {
    await accumulateUsage(
      { sessionId: "a" },
      { response: { usage: { inputTokens: 10, outputTokens: 0 } } },
    );
    await accumulateUsage(
      { sessionId: "b" },
      { response: { usage: { inputTokens: 120, outputTokens: 0 } } },
    );
    expect(total("a")).toBe(10);
    expect(total("b")).toBe(120);
    // Session b is over the hard cap (100); session a is not.
    expect((await enforceCap({ sessionId: "a" })).action).toBe("continue");
    expect((await enforceCap({ sessionId: "b" })).action).toBe("abort");
  });

  it("per-session userSettings override env for the hard cap (enforce-cap)", async () => {
    // Env hard cap is 100, but this session raises it to 500 via userSettings.
    const ctx = {
      sessionId: SID,
      getOwnSettings: () => ({ softTokens: 250, hardTokens: 500 }),
    };
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 120, outputTokens: 0 } } },
    ); // 120 >= env hard (100) but < session hard (500)
    expect((await enforceCap(ctx)).action).toBe("continue");

    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 400, outputTokens: 0 } } },
    ); // 520 >= 500
    expect((await enforceCap(ctx)).action).toBe("abort");
  });

  it("per-session userSettings override env for the soft cap (trim-downstream)", async () => {
    // Env soft cap is 50, but this session raises it to 250 via userSettings.
    const ctx = {
      sessionId: SID,
      getOwnSettings: () => ({ softTokens: 250, hardTokens: 500 }),
    };
    const triggered = [
      { name: "narrator", outputKind: "story" },
      { name: "codex", outputKind: "plugin" },
    ];
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 60, outputTokens: 0 } } },
    ); // 60 >= env soft (50) but < session soft (250): no trim
    expect((await trimDownstream(ctx, { triggered })).action).toBe("continue");

    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 200, outputTokens: 0 } } },
    ); // 260 >= 250: trim non-story
    const r = await trimDownstream(ctx, { triggered });
    expect(r.replace.triggered).toEqual([
      { name: "narrator", outputKind: "story" },
    ]);
  });

  it("falls back to env when getOwnSettings omits a key or returns empty", async () => {
    // Empty bucket → both thresholds resolve from env (100 / 50).
    expect(resolveLimits({})).toEqual({ soft: 50, hard: 100 });
    // Production-shaped bucket: because the userSettings specs declare NO default,
    // the runtime fills unset keys with `undefined` (not the old 150000/200000),
    // so the env layer stays reachable. Regression guard for the dead-env-fallback
    // bug where declared defaults silently shadowed the env.
    expect(
      resolveLimits({ softTokens: undefined, hardTokens: undefined }),
    ).toEqual({ soft: 50, hard: 100 });
    // Partial bucket → provided key wins, missing key falls back to env.
    expect(resolveLimits({ hardTokens: 999 })).toEqual({ soft: 50, hard: 999 });
    expect(resolveLimits({ softTokens: undefined, hardTokens: 999 })).toEqual({
      soft: 50,
      hard: 999,
    });
    // Absent accessor (scope-less / framework hook) → env.
    expect(resolveLimits(undefined)).toEqual({ soft: 50, hard: 100 });
  });

  it("ignores non-positive / non-numeric userSettings and falls back to env", async () => {
    // 0, negative, NaN-y, and blank values are all rejected by positiveNumber.
    expect(resolveLimits({ softTokens: 0, hardTokens: -1 })).toEqual({
      soft: 50,
      hard: 100,
    });
    expect(resolveLimits({ softTokens: "abc", hardTokens: "" })).toEqual({
      soft: 50,
      hard: 100,
    });
    // Numeric strings are accepted (UI may persist values as strings).
    expect(resolveLimits({ softTokens: "70", hardTokens: "140" })).toEqual({
      soft: 70,
      hard: 140,
    });
  });

  it("falls back to hardcoded defaults when neither userSettings nor env are set", async () => {
    delete process.env.COST_GATE_SOFT_TOKENS;
    delete process.env.COST_GATE_HARD_TOKENS;
    expect(resolveLimits(undefined)).toEqual({ soft: 400000, hard: 600000 });
    expect(resolveLimits({})).toEqual({ soft: 400000, hard: 600000 });
  });

  it("degrades gracefully when misconfigured (soft >= hard): hard cap still enforced", async () => {
    // Operator error: soft cap not below hard cap. trim-downstream then has no
    // window before enforce-cap, but the hard cap must still protect spend and
    // nothing should crash.
    process.env.COST_GATE_SOFT_TOKENS = "100";
    process.env.COST_GATE_HARD_TOKENS = "100";
    const triggered = [
      { name: "narrator", outputKind: "story" },
      { name: "codex", outputKind: "plugin" },
    ];

    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 99, outputTokens: 0 } } },
    );
    // Below both caps: turn proceeds untouched.
    expect(
      (await trimDownstream({ sessionId: SID }, { triggered })).action,
    ).toBe("continue");
    expect((await enforceCap({ sessionId: SID })).action).toBe("continue");

    // Reaching the hard cap still aborts the turn.
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 1, outputTokens: 0 } } },
    );
    expect((await enforceCap({ sessionId: SID })).action).toBe("abort");
  });

  it("PLUGIN.md userSettings declares NO default (keeps env fallback reachable)", () => {
    // The runtime fills a declared default for any unset userSettings key, which
    // would permanently shadow the env layer. The userSettings block must stay
    // default-less so an unset field resolves to undefined → env → hardcoded
    // default. (Structural guard; dependency-free to keep this a leaf plugin.)
    const mdPath = path.resolve(import.meta.dirname, "../PLUGIN.md");
    const md = fs.readFileSync(mdPath, "utf8");
    const frontmatter = md.split(/^---$/m)[1] ?? "";
    const lines = frontmatter.split("\n");
    const start = lines.findIndex((l) => l.startsWith("userSettings:"));
    expect(start).toBeGreaterThanOrEqual(0);
    // The block runs until the next top-level (non-indented) key.
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^[A-Za-z]/.test(lines[i])) {
        end = i;
        break;
      }
    }
    const block = lines.slice(start, end);
    expect(block.some((l) => /^\s*default:/.test(l))).toBe(false);
  });
});
