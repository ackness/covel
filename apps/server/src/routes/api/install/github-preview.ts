import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  githubPluginPreviewSchema,
  type GithubPluginPreview,
} from "@covel/shared";
import { httpError, type ExtractedEntry } from "./shared.js";
import {
  readPluginFrontmatter,
  validatePluginBundle,
} from "./plugin-bundle.js";
import { packageReceiptSchema } from "./package-files.js";

const signingKey = randomBytes(32);
export const previewLifetime = 15 * 60_000;
const pluginSchema = githubPluginPreviewSchema.omit({ token: true });
const signedSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.enum(["install", "world-install"]),
      plugin: pluginSchema,
    })
    .strict(),
  z
    .object({
      action: z.enum(["update", "world-update"]),
      plugin: pluginSchema,
      previous: packageReceiptSchema,
    })
    .strict(),
]);
type SignedPreview = z.infer<typeof signedSchema>;
export function signPreview(data: SignedPreview): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${createHmac("sha256", signingKey).update(payload).digest("base64url")}`;
}
export function verifyPreview(token: string): SignedPreview {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra)
    throw httpError(400, "Invalid plugin preview");
  const actual = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", signingKey).update(payload).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw httpError(400, "Invalid plugin preview; preview again");
  const result = signedSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  if (result.plugin.expiresAt <= Date.now())
    throw httpError(409, "Plugin preview expired; preview again");
  return result;
}
export function receiptEntry(
  preview: Omit<GithubPluginPreview, "token">,
): ExtractedEntry {
  return {
    relativePath: ".covel-install.json",
    content: Buffer.from(
      JSON.stringify(
        {
          source: preview.source,
          version: preview.version,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    ),
  };
}

export function inspectBundle(
  entries: readonly ExtractedEntry[],
  reserved: ReadonlySet<string>,
) {
  const { pluginId } = validatePluginBundle(entries, reserved);
  const pkg = z
    .object({
      version: z.string().max(100).optional(),
      dependencies: z.record(z.string(), z.unknown()).optional(),
      optionalDependencies: z.record(z.string(), z.unknown()).optional(),
      peerDependencies: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(
      JSON.parse(
        entries
          .find((e) => e.relativePath === "package.json")!
          .content.toString("utf8"),
      ),
    );
  if (
    [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies].some(
      (deps) => deps && Object.keys(deps).length > 0,
    )
  ) {
    throw httpError(
      400,
      "Plugin must ship self-contained runtime files without runtime dependencies; the installer never runs package managers or build scripts",
    );
  }
  const manifest =
    entries.find((e) => e.relativePath === "PLUGIN.md") ??
    entries.find((e) => /^runtimes\/[^/]+\/PLUGIN\.md$/.test(e.relativePath))!;
  const data = readPluginFrontmatter(manifest.content.toString("utf8"));
  const localized = z
    .record(z.string(), z.string())
    .safeParse(data.description);
  const description =
    typeof data.description === "string"
      ? data.description
      : localized.success
        ? (localized.data["en-US"] ??
          localized.data.en ??
          localized.data["zh-CN"] ??
          localized.data.zh ??
          "")
        : "";
  return {
    id: pluginId,
    version: pkg.version ?? null,
    description: description.slice(0, 1000),
    hasServerCode:
      entries.some((e) =>
        /\.(?:[cm]?js|tsx?|node|wasm)$/i.test(e.relativePath),
      ) ||
      entries
        .filter((e) => e.relativePath.endsWith("PLUGIN.md"))
        .some((e) => {
          const manifest = readPluginFrontmatter(e.content.toString("utf8"));
          return !!(
            manifest.entry ||
            manifest.handler ||
            manifest.guard ||
            manifest.tools
          );
        }),
  };
}
