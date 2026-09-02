import { describe, expect, it, vi } from "vitest";
import {
  abortSignalWithTimeout,
  assertEntityEnvelope,
  pickLocaleText,
  readManualEntity,
  splitList,
} from "../src/index.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

describe("abortSignalWithTimeout", () => {
  it("aborts provider work when the turn signal aborts", () => {
    const controller = new AbortController();
    const combined = abortSignalWithTimeout(controller.signal, 60_000);

    expect(combined.aborted).toBe(false);
    controller.abort(new Error("turn stopped"));
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toEqual(new Error("turn stopped"));
  });

  it("returns a timeout signal when the turn has no control signal", () => {
    const combined = abortSignalWithTimeout(undefined, 60_000);
    expect(combined).toBeInstanceOf(AbortSignal);
    expect(combined.aborted).toBe(false);
  });
});

describe("splitList", () => {
  it("splits strings on comma / fullwidth-comma / newline", () => {
    expect(splitList("a, b，c\nd")).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps string items of an array input", () => {
    expect(splitList([" x ", 1, "", "y"])).toEqual(["x", "y"]);
  });

  it("returns [] for non-string / non-array input and caps at 32", () => {
    expect(splitList(42)).toEqual([]);
    expect(splitList(undefined)).toEqual([]);
    expect(
      splitList(Array.from({ length: 40 }, (_, i) => `k${i}`)),
    ).toHaveLength(32);
  });
});

describe("pickLocaleText", () => {
  it("uses Simplified Chinese only for the default locale and aliases", () => {
    expect(pickLocaleText("ZH_cn", "中文", "English")).toBe("中文");
    expect(pickLocaleText("zh-Hans", "中文", "English")).toBe("中文");
    expect(pickLocaleText("zh-Hant-TW", "中文", "English")).toBe("English");
    expect(pickLocaleText("zh-TW", "中文", "English")).toBe("English");
    expect(pickLocaleText("en_GB", "中文", "English")).toBe("English");
    expect(pickLocaleText(undefined, "中文", "English")).toBe("English");
  });
});

describe("readManualEntity", () => {
  it("parses the <entity>Json branch and throws on invalid JSON", () => {
    expect(
      readManualEntity({ ruleJson: '{"id":"a"}' }, "rule", () => ({})),
    ).toEqual({ id: "a" });
    expect(() =>
      readManualEntity({ ruleJson: "{bad" }, "rule", () => ({})),
    ).toThrow("manualPayload.ruleJson must be valid JSON");
  });

  it("routes the <entity>Form branch through fromForm", () => {
    const fromForm = vi.fn(() => ({ built: true }));
    expect(
      readManualEntity({ ruleForm: { title: "t" } }, "rule", fromForm),
    ).toEqual({ built: true });
    expect(fromForm).toHaveBeenCalledWith({ title: "t" });
  });

  it("falls back to the raw <entity> object, else undefined", () => {
    expect(readManualEntity({ rule: { id: "r" } }, "rule", () => ({}))).toEqual(
      {
        id: "r",
      },
    );
    expect(readManualEntity("nope", "rule", () => ({}))).toBeUndefined();
  });
});

describe("assertEntityEnvelope", () => {
  const opts = {
    entity: "rule",
    idPattern: ID_PATTERN,
    idError: "rule.id must be 1-128 characters",
  };

  it("returns the built envelope on the happy path", () => {
    expect(assertEntityEnvelope({ id: "r1", extra: 1 }, opts)).toEqual({
      id: "r1",
      extra: 1,
      schemaVersion: 1,
    });
  });

  it("layers build() over the validated base", () => {
    expect(
      assertEntityEnvelope(
        { id: "r1" },
        { ...opts, build: (base) => ({ ...base, kind: "constant" }) },
      ),
    ).toMatchObject({ id: "r1", schemaVersion: 1, kind: "constant" });
  });

  it("supports a custom idField", () => {
    expect(
      assertEntityEnvelope(
        { characterId: "c1" },
        {
          entity: "presence",
          idField: "characterId",
          idPattern: ID_PATTERN,
          idError: "bad",
        },
      ),
    ).toMatchObject({ characterId: "c1", schemaVersion: 1 });
  });

  it("throws for non-object, bad id, bad pattern, bad schemaVersion, oversize", () => {
    expect(() => assertEntityEnvelope(undefined, opts)).toThrow(
      "manualPayload.rule must be an object",
    );
    expect(() => assertEntityEnvelope({}, opts)).toThrow(
      "rule.id must be a non-empty string",
    );
    expect(() => assertEntityEnvelope({ id: "../x" }, opts)).toThrow(
      "rule.id must be 1-128 characters",
    );
    expect(() =>
      assertEntityEnvelope({ id: "r1", schemaVersion: 2 }, opts),
    ).toThrow("rule.schemaVersion must be 1");
    expect(() =>
      assertEntityEnvelope({ id: "r1", blob: "x".repeat(70_000) }, opts),
    ).toThrow("rule is too large");
  });
});
