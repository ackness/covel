import { describe, it, expect } from "vitest";
import { summarizeTraceError } from "../src/function-runtime/trace-error.js";

describe("summarizeTraceError (bound the one soft PII spot)", () => {
  it("returns a short Error message unchanged", () => {
    expect(summarizeTraceError(new Error("ECONNREFUSED"))).toBe("ECONNREFUSED");
  });

  it("stringifies a non-Error value", () => {
    expect(summarizeTraceError("plain string")).toBe("plain string");
    expect(summarizeTraceError(42)).toBe("42");
  });

  it("collapses whitespace/newlines to a single line", () => {
    expect(summarizeTraceError(new Error("line one\n  line two\t\tx"))).toBe(
      "line one line two x",
    );
  });

  it("truncates an over-long message so a leaked prompt fragment is bounded", () => {
    const huge = "SECRET ".repeat(200); // ~1400 chars
    const out = summarizeTraceError(new Error(huge));
    expect(out.length).toBe(256 + 3); // 256 chars + the "..." marker
    expect(out.endsWith("...")).toBe(true);
  });
});
