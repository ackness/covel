import { z } from "zod";

export const packageValidationIssueSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.string(),
    file: z.string().optional(),
    field: z.string().optional(),
    message: z.string(),
    hint: z.string().optional(),
  })
  .strict();

export const packageValidationReportSchema = z
  .object({
    kind: z.enum(["plugin", "world"]),
    id: z.string().optional(),
    ok: z.boolean(),
    counts: z
      .object({
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
      })
      .strict(),
    issues: z.array(packageValidationIssueSchema),
    summary: z
      .object({
        version: z.string().optional(),
        languages: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((report, ctx) => {
    const errors = report.issues.filter(
      (issue) => issue.severity === "error",
    ).length;
    const warnings = report.issues.length - errors;
    if (report.counts.errors !== errors || report.counts.warnings !== warnings)
      ctx.addIssue({
        code: "custom",
        path: ["counts"],
        message: "Counts must agree with issues",
      });
    if (report.ok !== (errors === 0))
      ctx.addIssue({
        code: "custom",
        path: ["ok"],
        message: "ok must agree with error issues",
      });
  });

export type PackageValidationIssue = z.infer<
  typeof packageValidationIssueSchema
>;
export type PackageValidationReport = z.infer<
  typeof packageValidationReportSchema
>;
