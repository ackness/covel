/**
 * The rules of a plugin UI spec — the JSON file a package lists under
 * `contributes.ui` — written once. Static validation, installation and the
 * loader that serves `/api/ui-specs` all check a spec with
 * {@link pluginUiSpecIssues}, so a spec that passes `pnpm validate:plugin`
 * is not dropped in the game.
 */
import { z } from "zod";
import { PLUGIN_UI_COMPONENT_NAMES } from "../types/plugin-ui.js";

/** The newest `specVersion` this host understands. */
export const CURRENT_UI_SPEC_VERSION = 1;

/** Largest webview document a spec may embed. */
export const MAX_UI_WEBVIEW_BYTES = 512 * 1024;

const i18nTextSchema = z.union([z.string(), z.record(z.string(), z.string())]);
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
    icon: z.string().optional(),
    group: z.string().optional(),
    groupLabel: i18nTextSchema.optional(),
    groupOrder: z.number().optional(),
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
    const hasView = spec.view !== undefined && spec.view !== null;
    const hasWebview = spec.webview !== undefined && spec.webview !== null;
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
): PluginUiSpecIssue[] {
  const result = pluginUiSpecSchema.safeParse(spec);
  const issues: PluginUiSpecIssue[] = result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: formatPath(issue.path) || "(root)",
        message: issue.message,
      }));
  walkSpec(spec, "", (at, key, value) => {
    if (
      (key === "pluginId" ||
        key === "sourcePlugin" ||
        key === "sourcePluginId") &&
      value !== ownerPluginId
    )
      issues.push({
        path: at,
        message: `a UI binding must reference its owning plugin ${ownerPluginId}`,
      });
    if (
      (key === "$item" || key === "$bindItem") &&
      typeof value === "string" &&
      value.startsWith("/")
    )
      issues.push({
        path: at,
        message: `${JSON.stringify(value)} must not start with a slash; write the item's field name (${JSON.stringify(value.slice(1))})`,
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
  at: string,
  visit: (at: string, key: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      walkSpec(item, `${at}[${index}]`, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const child = at ? `${at}.${key}` : key;
    visit(child, key, item);
    walkSpec(item, child, visit);
  }
}
