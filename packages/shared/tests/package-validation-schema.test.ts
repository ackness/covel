import { describe, expect, it } from "vitest";
import { packageValidationReportSchema } from "../src/schemas/package-validation.js";
const report = {
  kind: "plugin",
  ok: false,
  counts: { errors: 1, warnings: 0 },
  issues: [
    {
      severity: "error",
      code: "unknown-field",
      file: "PLUGIN.md",
      field: "unknown",
      message: "Unknown field",
    },
  ],
};
describe("package validation report", () => {
  it("accepts structured reports", () =>
    expect(packageValidationReportSchema.parse(report)).toEqual(report));
  it.each([
    { ...report, extra: true },
    { ...report, counts: { ...report.counts, extra: true } },
    { ...report, summary: { extra: true } },
    { ...report, issues: [{ code: "missing", message: "Missing severity" }] },
    { ...report, issues: [{ ...report.issues[0], extra: true }] },
    { ...report, counts: { errors: 0, warnings: 0 } },
    { ...report, ok: true },
  ])("rejects inconsistent or non-strict reports %#", (input) =>
    expect(packageValidationReportSchema.safeParse(input).success).toBe(false),
  );
});
