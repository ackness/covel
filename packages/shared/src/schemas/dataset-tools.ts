/**
 * The tools a dataset can give an agent. A dataset declares which ones may be
 * generated (`contributes.datasets.<name>.tools`, derived from its `ops` when
 * omitted); an agent selects them with `agent.tools.datasets`.
 */

import { DATA_OP_KINDS, type DataOpKind } from "@covel/plugin-handlers-utils";

/** Tool kinds a dataset can generate, in their canonical order. */
export const DATASET_TOOL_KINDS = ["get", "list", "upsert", "update"] as const;

export type DatasetToolKind = (typeof DATASET_TOOL_KINDS)[number];

/** The model-facing name of one dataset tool: `<dataset>-<kind>`. */
export function datasetToolName(
  dataset: string,
  kind: DatasetToolKind,
): string {
  return `${dataset}-${kind}`;
}

/**
 * The tool kinds a dataset offers: the written `tools`, or by default `get`
 * and `list`, `upsert` when `set` is allowed, and `update` when any other
 * operation is.
 */
export function datasetToolKinds(declaration: {
  readonly ops?: readonly DataOpKind[];
  readonly tools?: readonly DatasetToolKind[];
}): DatasetToolKind[] {
  if (declaration.tools) return [...declaration.tools];
  const ops = declaration.ops ?? DATA_OP_KINDS;
  return [
    "get",
    "list",
    ...(ops.includes("set") ? (["upsert"] as const) : []),
    ...(ops.some((op) => op !== "set") ? (["update"] as const) : []),
  ];
}

/**
 * Written `tools` that the dataset's `ops` cannot serve: `upsert` replaces a
 * record (`set`), and `update` applies the other operations.
 */
export function datasetToolsIssues(declaration: {
  readonly ops?: readonly DataOpKind[];
  readonly tools?: readonly DatasetToolKind[];
}): { readonly index: number; readonly message: string }[] {
  const ops = declaration.ops ?? DATA_OP_KINDS;
  const issues: { index: number; message: string }[] = [];
  for (const [index, kind] of (declaration.tools ?? []).entries()) {
    if (kind === "upsert" && !ops.includes("set"))
      issues.push({
        index,
        message:
          "upsert needs the set operation; add set to ops or remove upsert",
      });
    if (kind === "update" && !ops.some((op) => op !== "set"))
      issues.push({
        index,
        message:
          "update needs an operation other than set; add one to ops or remove update",
      });
  }
  return issues;
}
