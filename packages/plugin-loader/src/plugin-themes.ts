import { createHash } from "node:crypto";
import {
  compilePluginThemeCss,
  MAX_PLUGIN_THEME_CSS_BYTES,
  MAX_PLUGIN_THEME_BITMAP_FILE_BYTES,
  MAX_PLUGIN_THEME_SPEC_BYTES,
  PLUGIN_THEME_POLICY_VERSION,
  pluginThemePathSchema,
  pluginThemeSpecSchema,
  resolvedPluginThemeSchema,
  type PluginThemeAssets,
  type PluginThemeIssue,
  type ResolvedPluginTheme,
} from "@covel/shared";
import { compileUiText, type MessageCatalog } from "./locale-messages.js";
import {
  planPluginAssetRoot,
  type IndexedPluginAssetFile,
  type PluginAssetRoot,
} from "./ui-assets.js";
import type { PluginThemeFiles } from "./theme-files.js";

export class PluginThemeError extends Error {
  constructor(
    readonly issues: readonly PluginThemeIssue[],
    readonly specId?: string,
  ) {
    super(
      issues
        .map(
          (issue) =>
            `${issue.file ? issue.file + ": " : ""}${issue.path}: ${issue.message}`,
        )
        .join("; "),
    );
    this.name = "PluginThemeError";
  }
}
const problem = (field: string, message: string, id?: string): never => {
  throw new PluginThemeError([{ path: field, message }], id);
};
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Signature evidence, independent of extensions, from the exact hashed bytes. */
export function isPluginThemeBitmap(bytes: Uint8Array, mime: string): boolean {
  const b = Buffer.from(bytes);
  if (mime === "image/png")
    return (
      b.length >= 24 &&
      b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      b.toString("latin1", 12, 16) === "IHDR"
    );
  if (mime === "image/jpeg")
    return b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  if (mime === "image/gif")
    return (
      b.length >= 13 &&
      ["GIF87a", "GIF89a"].includes(b.toString("latin1", 0, 6))
    );
  if (mime === "image/webp")
    return (
      b.length >= 20 &&
      b.toString("latin1", 0, 4) === "RIFF" &&
      b.toString("latin1", 8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(b.toString("latin1", 12, 16))
    );
  if (
    mime === "image/avif" &&
    b.length >= 24 &&
    b.toString("latin1", 4, 8) === "ftyp"
  ) {
    const end = b.readUInt32BE(0);
    if (end < 24 || end > b.length || end % 4 !== 0) return false;
    for (let offset = 8; offset < end; offset += 4)
      if (
        offset !== 12 &&
        ["avif", "avis"].includes(b.toString("latin1", offset, offset + 4))
      )
        return true;
  }
  return false;
}

/** One compiler for live discovery, static disk checks and archive admission. */
export function compilePluginTheme(params: {
  pluginId: string;
  declaredPath: string;
  files: PluginThemeFiles;
  catalogs?: readonly MessageCatalog[];
}): {
  theme: ResolvedPluginTheme;
  asset?: Omit<PluginAssetRoot, "rootDir">;
  assetRoot?: string;
} {
  const { pluginId, declaredPath, files, catalogs = [] } = params;
  let raw: unknown;
  try {
    if (
      !pluginThemePathSchema.safeParse(declaredPath).success ||
      !declaredPath.endsWith(".json")
    )
      return problem("(root)", "theme descriptor must be JSON");
    const bytes = files.read(declaredPath, MAX_PLUGIN_THEME_SPEC_BYTES);
    if (bytes.byteLength > MAX_PLUGIN_THEME_SPEC_BYTES)
      return problem("(root)", "theme descriptor exceeds 32 KiB");
    raw = JSON.parse(decode(bytes));
  } catch {
    return problem(
      "(root)",
      "cannot read a bounded UTF-8 JSON theme descriptor",
    );
  }
  const specId =
    raw &&
    typeof raw === "object" &&
    "id" in raw &&
    typeof raw.id === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/.test(raw.id)
      ? raw.id
      : undefined;
  const parsed = pluginThemeSpecSchema.safeParse(compileUiText(raw, catalogs));
  if (!parsed.success)
    throw new PluginThemeError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: "invalid theme field",
      })),
      specId,
    );
  const spec = parsed.data;
  if (Buffer.byteLength(canonical(spec)) > MAX_PLUGIN_THEME_SPEC_BYTES)
    return problem(
      "(root)",
      "localized theme descriptor exceeds 32 KiB",
      spec.id,
    );
  let assets: PluginThemeAssets | undefined;
  let asset: Omit<PluginAssetRoot, "rootDir"> | undefined;
  if (spec.assets) {
    try {
      const plan = planPluginAssetRoot(files.list(spec.assets.root), {
        purpose: "theme",
      });
      if (plan.issues.length) throw new PluginThemeError(plan.issues, spec.id);
      const indexed = new Map<string, IndexedPluginAssetFile>();
      for (const [relative, metadata] of [...plan.listed].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        const bytes = files.read(
          `${spec.assets.root}/${relative}`,
          MAX_PLUGIN_THEME_BITMAP_FILE_BYTES,
        );
        if (
          bytes.byteLength !== metadata.size ||
          !isPluginThemeBitmap(bytes, metadata.mime)
        )
          return problem(
            "assets.root",
            "listed file is not a matching stable bitmap",
            spec.id,
          );
        indexed.set(relative, { ...metadata, sha256: hash(bytes) });
      }
      // Purpose is part of identity: overlapping roots keep separate publication indexes.
      const digest = hash(
        canonical({ purpose: "theme", files: [...indexed] }),
      ).slice(0, 32);
      assets = {
        digest,
        files: [...indexed].map(([path, metadata]) => ({
          path,
          mime: metadata.mime as PluginThemeAssets["files"][number]["mime"],
          size: metadata.size,
        })),
      };
      asset = { purpose: "theme", pluginId, digest, files: indexed };
    } catch (error) {
      if (error instanceof PluginThemeError) throw error;
      return problem(
        "assets.root",
        "cannot inspect a bounded bitmap root without links",
        spec.id,
      );
    }
  }
  let css: string | undefined;
  let cssBytesHash: string | undefined;
  let cssText: string | undefined;
  const temporaryScope = "0".repeat(64);
  if (spec.css) {
    try {
      const bytes = files.read(spec.css, MAX_PLUGIN_THEME_CSS_BYTES);
      if (bytes.byteLength > MAX_PLUGIN_THEME_CSS_BYTES)
        return problem("css", "CSS exceeds 64 KiB", spec.id);
      cssBytesHash = hash(bytes);
      css = decode(bytes);
    } catch {
      return problem("css", "cannot read a bounded UTF-8 CSS file", spec.id);
    }
    const compiled = compilePluginThemeCss(css, {
      pluginId,
      scope: temporaryScope,
      assets,
    });
    if (!compiled.success)
      throw new PluginThemeError(
        compiled.issues.map((issue) => ({
          ...issue,
          file: spec.css,
          path: `css.${issue.path}`,
        })),
        spec.id,
      );
    cssText = compiled.css;
  }
  const semantics = {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    tokens: spec.tokens,
    layout: spec.layout,
  };
  // Hash all translations and exact CSS bytes before binding selectors to the hash.
  const contentHash = hash(
    canonical({
      policy: PLUGIN_THEME_POLICY_VERSION,
      pluginId,
      ...semantics,
      cssBytesHash,
      assets,
    }),
  );
  if (css !== undefined) {
    const compiled = compilePluginThemeCss(css, {
      pluginId,
      scope: contentHash,
      assets,
    });
    if (!compiled.success) throw new PluginThemeError(compiled.issues, spec.id);
    cssText = compiled.css;
  }
  const theme = resolvedPluginThemeSchema.parse({
    pluginId,
    ...semantics,
    contentHash,
    ...(cssText === undefined ? {} : { cssText }),
    ...(assets ? { assets } : {}),
  });
  return { theme, asset, assetRoot: spec.assets?.root };
}
