// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { PackageValidationReport } from "@covel/shared";
import {
  groupIssues,
  issueMessage,
  renderPlainText,
} from "../package-validation-model.js";
const report: PackageValidationReport = {
  kind: "plugin",
  id: "probe",
  ok: false,
  counts: { errors: 2, warnings: 1 },
  summary: { version: "1.0.0", languages: "en" },
  issues: [
    { severity: "warning", code: "w", file: "PLUGIN.md", message: "Warning" },
    {
      severity: "error",
      code: "e",
      file: "z.json",
      message: "Invalid",
      hint: "Fix it",
    },
    {
      severity: "error",
      code: "e",
      file: "a.json",
      field: "view.component",
      message: "Missing",
    },
  ],
};
describe("validation report model", () => {
  it("groups errors before warnings, then sorts files", () => {
    expect(
      groupIssues(report).map(({ severity, file }) => [severity, file]),
    ).toEqual([
      ["error", "a.json"],
      ["error", "z.json"],
      ["warning", "PLUGIN.md"],
    ]);
  });
  it("renders all report details as plain text", () => {
    expect(renderPlainText(report)).toBe(
      "plugin probe 1.0.0\n2 / 1 (error / warning)\nen\n[error] a.json: view.component\nMissing\n[error] z.json\nInvalid\nFix it\n[warning] PLUGIN.md\nWarning",
    );
  });
  it("uses a localised known code and falls back to the original message", () => {
    const [warning, error] = report.issues;
    if (!warning || !error) throw new Error("Missing fixture");
    const localize = (code: string) => (code === "w" ? "提示" : undefined);
    expect(issueMessage(warning, localize)).toBe("提示");
    expect(issueMessage(error, localize)).toBe("Invalid");
    expect(renderPlainText(report, localize)).toContain("提示");
  });
  it("keeps issues without a file and combines matching groups", () => {
    const input: PackageValidationReport = {
      kind: "world",
      ok: true,
      counts: { errors: 0, warnings: 2 },
      issues: [
        { severity: "warning", code: "a", message: "A" },
        { severity: "warning", code: "b", message: "B" },
      ],
    };
    expect(groupIssues(input)).toEqual([
      { severity: "warning", file: undefined, issues: input.issues },
    ]);
  });
});
