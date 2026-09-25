import { createHash } from "node:crypto";
import { outboundFetch } from "@covel/ai-provider";
import { z } from "zod";
import {
  httpError,
  LIMITS,
  readAllEntries,
  type ExtractedEntry,
} from "./shared.js";

export interface GithubLocation {
  owner: string;
  repo: string;
  ref?: string;
  directory: string;
}

export function parseGithubUrl(input: string): GithubLocation {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw httpError(400, "Enter an HTTPS GitHub repository or tree URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\\\x00-\x20]/.test(input)
  ) {
    throw httpError(
      400,
      "Only public https://github.com repository or tree URLs are supported",
    );
  }
  const parts = url.pathname.replace(/\/$/, "").slice(1).split("/");
  const [owner, rawRepo, kind, rawRef, ...directory] = parts;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (
    !owner ||
    !repo ||
    !/^[a-z0-9-]+$/i.test(owner) ||
    !/^[a-z0-9_.-]+$/i.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    throw httpError(400, "Invalid GitHub repository");
  }
  if (parts.length === 2) return { owner, repo, directory: "" };
  if (kind !== "tree" || !rawRef)
    throw httpError(
      400,
      "Use a repository URL or /tree/<ref>/<plugin-path> URL",
    );
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      throw httpError(400, "Invalid URL encoding");
    }
  };
  const ref = decode(rawRef);
  const dirs = directory.map(decode);
  if (
    !/^[a-z0-9_./-]{1,200}$/i.test(ref) ||
    ref.split("/").some((p) => !p || p === "." || p === "..") ||
    dirs.some((p) => !/^[a-z0-9_.-]+$/i.test(p) || p === "." || p === "..")
  ) {
    throw httpError(
      400,
      "Invalid Git ref or plugin path; encode slashes in branch names as %2F",
    );
  }
  return { owner, repo, ref, directory: dirs.join("/") };
}

// URLs are constructed here, never taken from API responses. Redirects are
// rejected (including repository renames); no browser/operator credentials leave Covel.
async function download(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await outboundFetch(url, {
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      "User-Agent": "Covel-Plugin-Installer",
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 403 || response.status === 429)
      throw httpError(
        429,
        "GitHub rate limit or access restriction; try again later or upload a ZIP",
      );
    if (response.status === 404)
      throw httpError(404, "Public GitHub repository or ref not found");
    throw httpError(
      502,
      `GitHub download failed (${response.status}); use the repository's current canonical URL`,
    );
  }
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw httpError(413, "GitHub download exceeds the size limit");
  }
  if (!response.body) throw httpError(502, "GitHub returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw httpError(413, "GitHub download exceeds the size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function resolveGithubCommit(
  location: GithubLocation,
  signal?: AbortSignal,
): Promise<string> {
  const base = `https://api.github.com/repos/${location.owner}/${location.repo}/commits`;
  const url = location.ref
    ? `${base}/${encodeURIComponent(location.ref)}`
    : `${base}?per_page=1`;
  const json: unknown = JSON.parse(
    (await download(url, 1024 * 1024, signal)).toString("utf8"),
  );
  const commit = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) });
  return location.ref
    ? commit.parse(json).sha
    : z.array(commit).min(1).parse(json)[0]!.sha;
}

export async function downloadGithubEntries(
  location: Pick<GithubLocation, "owner" | "repo">,
  commit: string,
  signal?: AbortSignal,
): Promise<ExtractedEntry[]> {
  const buffer = await download(
    `https://codeload.github.com/${location.owner}/${location.repo}/zip/${commit}`,
    LIMITS.maxUploadBytes,
    signal,
  );
  const entries = await readAllEntries(
    buffer,
    "/covel-github-install-sentinel",
  );
  const roots = new Set(entries.map((e) => e.relativePath.split("/")[0]));
  if (roots.size !== 1 || entries.some((e) => !e.relativePath.includes("/")))
    throw httpError(400, "Invalid GitHub archive layout");
  return entries.map((e) => ({
    ...e,
    relativePath: e.relativePath.slice(e.relativePath.indexOf("/") + 1),
  }));
}

export function selectPluginEntries(
  entries: readonly ExtractedEntry[],
  directory: string,
): ExtractedEntry[] {
  const prefix = directory ? `${directory}/` : "";
  return entries
    .filter((e) => e.relativePath.startsWith(prefix))
    .map((e) => ({ ...e, relativePath: e.relativePath.slice(prefix.length) }));
}

export function findPluginDirectories(
  entries: readonly ExtractedEntry[],
  directory: string,
): string[] {
  const selected = selectPluginEntries(entries, directory);
  const files = new Set(selected.map((e) => e.relativePath));
  const isPlugin = (prefix: string) =>
    files.has(`${prefix}package.json`) &&
    [...files].some(
      (p) =>
        p === `${prefix}PLUGIN.md` ||
        (p.startsWith(prefix) &&
          /^runtimes\/[^/]+\/PLUGIN\.md$/.test(p.slice(prefix.length))),
    );
  if (isPlugin("")) return [directory];
  const dirs = [...files]
    .filter(
      (p) =>
        p.endsWith("/package.json") &&
        !p.split("/").some((s) => s.startsWith(".") || s === "node_modules"),
    )
    .map((p) => p.slice(0, -"package.json".length))
    .filter(isPlugin);
  if (dirs.length === 0)
    throw httpError(
      400,
      "No plugin found; expected package.json and PLUGIN.md (or runtimes/*/PLUGIN.md)",
    );
  if (dirs.length > 20)
    throw httpError(
      400,
      "Too many plugins; paste a specific plugin subdirectory URL",
    );
  return dirs
    .sort()
    .map((p) => [directory, p.slice(0, -1)].filter(Boolean).join("/"));
}

export function digestEntries(entries: readonly ExtractedEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  )) {
    hash.update(JSON.stringify([entry.relativePath, entry.content.length]));
    hash.update(entry.content);
  }
  return hash.digest("hex");
}
