import { describe, expect, it } from "vitest";
import {
  contentBasisOf,
  contentFingerprint,
  createReadBaselineRecorder,
  validateReadScopes,
} from "../src/read-baselines.js";

describe("content read evidence", () => {
  it("ignores object enumeration order and preserves array order and content fields", () => {
    expect(contentFingerprint({ b: 2, a: 1 })).toBe(
      contentFingerprint({ a: 1, b: 2 }),
    );
    expect(contentFingerprint([1, 2])).not.toBe(contentFingerprint([2, 1]));
    expect(contentFingerprint({ updatedAt: "a" })).not.toBe(
      contentFingerprint({ updatedAt: "b" }),
    );
    const bases = [
      { exists: false } as const,
      ...[null, false, 0, "", [], {}].map((value) => ({
        exists: true as const,
        value,
      })),
    ].map(contentBasisOf);
    expect(new Set(bases.map((basis) => JSON.stringify(basis))).size).toBe(
      bases.length,
    );
  });

  it.each([
    undefined,
    NaN,
    Infinity,
    () => {},
    new Date(),
    { nested: undefined },
  ])("refuses non-JSON observations", (value) => {
    expect(() => contentFingerprint(value)).toThrow("Read-baseline evidence");
  });

  it("rejects cycles without inventing a JSON representation", () => {
    const value: unknown[] = [];
    value.push(value);
    expect(() => contentFingerprint(value)).toThrow("Read-baseline evidence");
  });

  it("owns the earliest observation, deduplicates reads and marks an unstable external basis", () => {
    const recorder = createReadBaselineRecorder();
    const original = {
      kind: "plugin-data" as const,
      pluginId: "p",
      namespace: "n",
      key: "k",
      basis: contentBasisOf({ exists: true, value: { score: 10 } }),
    };
    recorder.observe(original);
    for (let i = 0; i < 5000; i++) recorder.observe(original);
    expect(recorder.snapshot()).toHaveLength(1);
    recorder.observe({
      ...original,
      basis: contentBasisOf({ exists: true, value: { score: 20 } }),
    });
    expect(recorder.snapshot()).toEqual([{ ...original, unstable: true }]);
    Object.assign(original.basis, { fingerprint: "forged" });
    expect(recorder.snapshot()[0]?.basis).not.toEqual(original.basis);
  });

  it("latches excessive evidence instead of dropping guards after an author catches the diagnostic", () => {
    const recorder = createReadBaselineRecorder();
    expect(() => {
      for (let i = 0; i < 4097; i++)
        recorder.observe({
          kind: "plugin-data",
          pluginId: "p",
          namespace: "n",
          key: String(i),
          basis: { exists: false },
        });
    }).toThrow("Read fewer records");
    expect(() => recorder.snapshot()).toThrow("Read fewer records");
    expect(() =>
      validateReadScopes([
        { reads: [{ kind: "plugin-data", basis: "forged" }] },
      ]),
    ).toThrow("Read-baseline evidence");
  });
});
