import { z } from "zod";

export const PLUGIN_VIEW_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
// Kept aligned with pluginIdSchema; importing the manifest here would cycle
// through worldManifestSchema. The agreement is covered by view-mode.test.ts.
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export type PluginViewMode = `plugin:${string}:${string}`;
export type DefaultViewMode = "stage" | "parsed" | PluginViewMode;

export function parsePluginViewMode(
  mode: string,
): { pluginId: string; viewId: string } | undefined {
  const parts = mode.split(":");
  const [prefix, pluginId, viewId] = parts;
  if (
    parts.length !== 3 ||
    prefix !== "plugin" ||
    !pluginId ||
    !viewId ||
    !PLUGIN_ID_PATTERN.test(pluginId) ||
    !PLUGIN_VIEW_ID_PATTERN.test(viewId)
  )
    return undefined;
  return { pluginId, viewId };
}

export function pluginViewMode(
  pluginId: string,
  viewId: string,
): PluginViewMode {
  const mode: PluginViewMode = `plugin:${pluginId}:${viewId}`;
  if (!parsePluginViewMode(mode)) throw new Error("Invalid plugin view mode");
  return mode;
}

export const viewModeSchema = z
  .union([
    z.enum(["stage", "parsed"]),
    z
      .string()
      .refine(
        (mode): mode is PluginViewMode =>
          parsePluginViewMode(mode) !== undefined,
        "must be plugin:<pluginId>:<viewId> with lowercase letter, digit and hyphen IDs",
      ),
  ])
  .describe(
    "Initial session view: stage, parsed, or plugin:<pluginId>:<viewId>. Plugin IDs start with a lowercase letter; view IDs use the same characters and are at most 64 characters. Missing views fall back to the host view; session bridge access requires player consent.",
  );
