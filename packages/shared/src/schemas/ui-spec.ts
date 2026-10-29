/**
 * The rules of a plugin UI spec — the JSON file a package lists under
 * `contributes.ui` — written once. Static validation, installation and the
 * loader that serves `/api/ui-specs` all check a spec with
 * {@link pluginUiSpecIssues}, so a spec that passes `pnpm validate:plugin`
 * is not dropped in the game.
 */
import { z } from "zod";
import { PLUGIN_VIEW_ID_PATTERN } from "./view-mode.js";
import { PLUGIN_UI_COMPONENT_NAMES } from "../types/plugin-ui.js";

/** The newest `specVersion` this host understands. */
export const CURRENT_UI_SPEC_VERSION = 1;

/** Largest webview document a spec may embed. */
export const MAX_UI_WEBVIEW_BYTES = 512 * 1024;

const i18nTextSchema = z.union([z.string(), z.record(z.string(), z.string())]);
/** Value-to-label expressions share one shape in validation and rendering. */
export const uiMapDirectiveSchema = z.strictObject({
  $map: z.unknown(),
  labels: z.record(z.string(), i18nTextSchema),
  fallback: z.unknown().optional(),
});

const filterItemsSchema = z.union([
  z.strictObject({ $state: z.string().startsWith("/") }),
  z.strictObject({ $item: z.string() }),
  z.strictObject({ $bindState: z.string().startsWith("/") }),
  z.strictObject({ $bindItem: z.string() }),
]);

const componentNameSchema = z.enum(PLUGIN_UI_COMPONENT_NAMES, {
  error: (issue) =>
    `unknown component ${typeof issue.input === "string" ? issue.input : JSON.stringify(issue.input)}; use a component name from docs/reference/ui-components.md`,
});

const STATE_PATH_MESSAGE =
  'must be an absolute state path string such as "/entries", or { "$item": "field" } inside another repeat';

const actionBindingSchema = z.looseObject({
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  confirm: z.unknown().optional(),
  onSuccess: z.unknown().optional(),
  onError: z.unknown().optional(),
  preventDefault: z.boolean().optional(),
});
const actionBindingListSchema = z.union([
  actionBindingSchema,
  z.array(actionBindingSchema).min(1),
]);

/**
 * One node of a declarative view. Props and expressions stay open; the
 * component vocabulary is closed, because a package cannot add a component.
 */
const uiViewNodeSchema: z.ZodType = z.lazy(() =>
  z
    .looseObject({
      component: componentNameSchema.optional(),
      type: componentNameSchema.optional(),
      props: z.record(z.string(), z.unknown()).optional(),
      children: z.array(uiViewNodeSchema).optional(),
      slots: z.record(z.string(), z.array(uiViewNodeSchema)).optional(),
      on: z.record(z.string(), actionBindingListSchema).optional(),
      watch: z.record(z.string(), actionBindingListSchema).optional(),
      repeat: z
        .looseObject({
          statePath: z.union(
            [
              z.string().startsWith("/", { message: STATE_PATH_MESSAGE }),
              z.strictObject({ $item: z.string().min(1) }),
            ],
            { error: STATE_PATH_MESSAGE },
          ),
          key: z.string().min(1).optional(),
        })
        .optional(),
      visible: z.unknown().optional(),
    })
    .superRefine((node, ctx) => {
      if ((node.component ?? node.type) === "FilterContainer") {
        const props = z
          .looseObject({
            items: filterItemsSchema,
            itemTemplate: uiViewNodeSchema,
            itemComponent: z.never().optional(),
            itemPropMap: z.never().optional(),
            itemLiteralProps: z.never().optional(),
          })
          .safeParse(node.props);
        if (!props.success)
          for (const issue of props.error.issues)
            ctx.addIssue({ ...issue, path: ["props", ...issue.path] });
        if (node.children || node.repeat || node.slots)
          ctx.addIssue({
            code: "custom",
            message:
              "FilterContainer renders props.itemTemplate for each item; use that subtree instead of children, slots or repeat",
          });
      }
      if (!node.component && !node.type)
        ctx.addIssue({
          code: "custom",
          path: ["component"],
          message:
            "a UI node needs a component; use a component name from docs/reference/ui-components.md",
        });
      if (node.component && node.type && node.component !== node.type)
        ctx.addIssue({
          code: "custom",
          path: ["type"],
          message:
            "component and type name different components; keep component only",
        });
    }),
);

/**
 * A UI spec as the author writes it. Unknown top-level keys are ignored, so
 * a newer spec field does not hide the panel on this host.
 */
export const pluginUiSpecSchema = z
  .looseObject({
    specVersion: z
      .number()
      .int()
      .min(1)
      .max(CURRENT_UI_SPEC_VERSION, {
        message: `unsupported specVersion (this host supports up to ${CURRENT_UI_SPEC_VERSION})`,
      })
      .optional(),
    id: z.string().min(1).optional(),
    label: i18nTextSchema.optional(),
    shortLabel: i18nTextSchema.optional(),
    description: i18nTextSchema.optional(),
    bridge: z.literal("session").optional(),
    icon: z.string().optional(),
    group: z.string().optional(),
    groupLabel: i18nTextSchema.optional(),
    groupOrder: z.number().optional(),
    navTarget: z.enum(["images"]).optional(),
    dataSource: z
      .looseObject({
        namespace: z.string().optional(),
        source: z.string().optional(),
        bindings: z
          .record(
            z.string().regex(/^[a-z][a-zA-Z0-9_]*$/),
            z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
          )
          .refine((bindings) => Object.keys(bindings).length <= 8, {
            message: "at most 8 bindings",
          })
          .optional(),
      })
      .optional(),
    emptyState: z
      .looseObject({ message: i18nTextSchema.optional() })
      .optional(),
    alwaysRender: z.boolean().optional(),
    surfaces: z
      .array(z.enum(["panel", "stage"]))
      .min(1)
      .optional(),
    webview: z
      .strictObject({
        entry: z.string().regex(/\.html$/, {
          message: "must reference a local .html document",
        }),
        height: z.number().int().min(80).max(800).optional(),
      })
      .optional(),
    view: uiViewNodeSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    walkSpec(spec, [], (at, key, value, parent) => {
      if (key === "$map") {
        const mapped = uiMapDirectiveSchema.safeParse(parent);
        if (!mapped.success)
          for (const issue of mapped.error.issues)
            ctx.addIssue({
              ...issue,
              path: [...at.slice(0, -1), ...issue.path],
            });
      }
      if (
        (key === "$item" || key === "$bindItem") &&
        typeof value === "string" &&
        value.startsWith("/")
      )
        ctx.addIssue({
          code: "custom",
          path: at,
          message: `${JSON.stringify(value)} must not start with a slash; write the item's field name (${JSON.stringify(value.slice(1))})`,
        });
    });
    const hasView = spec.view !== undefined && spec.view !== null;
    const hasWebview = spec.webview !== undefined && spec.webview !== null;
    if (spec.bridge && !hasWebview)
      ctx.addIssue({
        code: "custom",
        path: ["bridge"],
        message:
          "bridge applies to a webview; a json-render view reads its own plugin data through dataSource",
      });
    if (hasView && hasWebview)
      ctx.addIssue({
        code: "custom",
        path: ["webview"],
        message:
          "a UI spec declares either view or webview; remove one of them",
      });
    else if (!hasView && !hasWebview)
      ctx.addIssue({
        code: "custom",
        path: ["view"],
        message: "a UI spec declares either view or webview; add one of them",
      });
  });

export interface PluginUiSpecIssue {
  /** JSON path inside the spec, such as `view.children[0].component`, or `(root)`. */
  readonly path: string;
  readonly message: string;
}

/**
 * Everything wrong with an authored UI spec. Besides the schema: every
 * plugin binding names its owner (cross-plugin data goes through kernel
 * views), and `$item` / `$bindItem` name a field of the current item, never
 * a state path.
 */
export function pluginUiSpecIssues(
  spec: unknown,
  ownerPluginId: string,
  slot?: "right" | "message" | "view",
): PluginUiSpecIssue[] {
  const result = pluginUiSpecSchema.safeParse(spec);
  const issues: PluginUiSpecIssue[] = result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: formatPath(issue.path) || "(root)",
        message: issue.message,
      }));
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    const record = spec as Record<string, unknown>;
    if (slot === "view") {
      for (const field of ["id", "label"])
        if (record[field] === undefined)
          issues.push({
            path: field,
            message: `${field} is required in contributes.ui.view`,
          });
      if (
        typeof record.id === "string" &&
        !PLUGIN_VIEW_ID_PATTERN.test(record.id)
      )
        issues.push({
          path: "id",
          message:
            "id in contributes.ui.view must match ^[a-z][a-z0-9-]{0,63}$",
        });
      for (const field of [
        "surfaces",
        "group",
        "groupLabel",
        "groupOrder",
        "shortLabel",
        "navTarget",
      ])
        if (record[field] !== undefined)
          issues.push({ path: field, message: "not valid in a view" });
    } else if (record.bridge !== undefined) {
      issues.push({
        path: "bridge",
        message: "bridge is only valid in contributes.ui.view",
      });
    }
  }
  walkSpec(spec, [], (at, key, value) => {
    if (
      (key === "pluginId" ||
        key === "sourcePlugin" ||
        key === "sourcePluginId") &&
      value !== ownerPluginId
    )
      issues.push({
        path: formatPath(at),
        message: `a UI binding must reference its owning plugin ${ownerPluginId}`,
      });
  });
  return issues;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((segment, index) =>
      typeof segment === "number"
        ? `[${segment}]`
        : `${index ? "." : ""}${String(segment)}`,
    )
    .join("");
}

function walkSpec(
  value: unknown,
  at: (string | number)[],
  visit: (
    at: (string | number)[],
    key: string,
    value: unknown,
    parent: Record<string, unknown>,
  ) => void,
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      walkSpec(item, [...at, index], visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const child = [...at, key];
    visit(child, key, item, value as Record<string, unknown>);
    // Label keys and locale keys are data, never bindings or directives.
    if (key !== "labels" || !Object.hasOwn(value, "$map"))
      walkSpec(item, child, visit);
  }
}
