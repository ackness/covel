import type {
  PackageValidationIssue,
  PackageValidationReport,
} from "@covel/shared";

export interface IssueGroup {
  severity: PackageValidationIssue["severity"];
  file?: string;
  issues: PackageValidationIssue[];
}
export function groupIssues(report: PackageValidationReport): IssueGroup[] {
  const groups: IssueGroup[] = [];
  for (const severity of ["error", "warning"] as const) {
    const files = new Map<string | undefined, PackageValidationIssue[]>();
    for (const issue of report.issues) {
      if (issue.severity !== severity) continue;
      const list = files.get(issue.file) ?? [];
      list.push(issue);
      files.set(issue.file, list);
    }
    for (const [file, issues] of [...files].sort(([a], [b]) =>
      (a ?? "").localeCompare(b ?? ""),
    ))
      groups.push({ severity, file, issues });
  }
  return groups;
}
export function issueMessage(
  issue: PackageValidationIssue,
  localize?: (code: string, message: string) => string | undefined,
): string {
  return localize?.(issue.code, issue.message) ?? issue.message;
}
export function renderPlainText(
  report: PackageValidationReport,
  localize?: (code: string, message: string) => string | undefined,
): string {
  return [
    [report.kind, report.id, report.summary?.version].filter(Boolean).join(" "),
    `${report.counts.errors} / ${report.counts.warnings} (error / warning)`,
    ...(report.summary?.languages ? [report.summary.languages] : []),
    ...groupIssues(report).flatMap((group) =>
      group.issues.map((issue) =>
        [
          `[${issue.severity}] ${[issue.file, issue.field].filter(Boolean).join(": ")}`,
          issueMessage(issue, localize),
          issue.hint,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ),
  ].join("\n");
}
