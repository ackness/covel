import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { compileManifestLabels, parseLocaleFile } from "@covel/plugin-loader";
import {
  githubPluginPreviewSchema,
  i18nTextSchema,
  type GithubPluginPreview,
} from "@covel/shared";
import {
  httpError,
  INSTALL_RECEIPT_FILE,
  type ExtractedEntry,
} from "./shared.js";
import { validatePluginBundle } from "./plugin-bundle.js";
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
    relativePath: INSTALL_RECEIPT_FILE,
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
  /** Name of the directory that holds the package; see `packageDirectoryName`. */
  directory?: string,
) {
  const { pluginId, manifest, version, hasServerCode } = validatePluginBundle(
    entries,
    reserved,
    directory,
  );
  const labels = entries
    .filter((entry) => /^locales\/[^/]+\.ya?ml$/.test(entry.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .flatMap((entry) => {
      const file = parseLocaleFile(
        entry.content.toString("utf8"),
        entry.relativePath,
      );
      const overlay = file?.document["PLUGIN.md"];
      return file && overlay != null ? [{ ...file, overlay }] : [];
    });
  const { data } = compileManifestLabels(manifest.rawFrontmatter, labels);
  const description = i18nTextSchema.parse(data.description ?? "");
  return {
    id: pluginId,
    version,
    description:
      typeof description === "string"
        ? description.slice(0, 1000)
        : Object.fromEntries(
            Object.entries(description).map(([locale, text]) => [
              locale,
              text.slice(0, 1000),
            ]),
          ),
    author: manifest.plugin.author?.name ?? null,
    hasServerCode,
  };
}
