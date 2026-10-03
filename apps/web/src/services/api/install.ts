import { z } from "zod";
import {
  githubBatchInstallResultSchema,
  githubCollectionPreviewSchema,
  githubPluginUpdateCheckSchema,
  pluginInstallationsSchema,
  type GithubBatchInstallResult,
} from "@covel/shared";
import { getDesktopRestAuthHeaders } from "@/lib/desktop-bridge.js";
import { request } from "./request.js";

export type InstallKind = "plugin" | "world";

const installResultSchema = z
  .object({
    ok: z.literal(true),
    kind: z.enum(["plugin", "world"]),
    id: z.string().min(1),
    restartRequired: z.boolean(),
  })
  .strict();

export type InstallResult = z.infer<typeof installResultSchema>;

/** Install one plugin or world zip through the canonical multipart endpoint. */
export function installPackage(
  kind: InstallKind,
  file: File,
): Promise<InstallResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  return request(`/api/install/${kind}`, {
    method: "POST",
    headers: getDesktopRestAuthHeaders(),
    body: form,
    operatorAuth: true,
    schema: installResultSchema,
  });
}

/** Install a packed collection ZIP: every member, or none. */
export function installCollectionZip(
  file: File,
): Promise<GithubBatchInstallResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  return request("/api/install/collection", {
    method: "POST",
    headers: getDesktopRestAuthHeaders(),
    body: form,
    operatorAuth: true,
    schema: githubBatchInstallResultSchema,
  });
}

/** Preview every plugin, world or collection member under one GitHub URL. */
export async function previewGithubCollection(
  url: string,
  signal?: AbortSignal,
) {
  return request("/api/install/github/preview", {
    method: "POST",
    headers: getDesktopRestAuthHeaders(),
    body: JSON.stringify({ url }),
    operatorAuth: true,
    signal,
    silentErrors: true,
    schema: githubCollectionPreviewSchema,
  });
}

/** Install the previewed packages as a unit: all of them or none. */
export function installGithubPackages(
  tokens: readonly string[],
): Promise<GithubBatchInstallResult> {
  return request("/api/install/github/batch", {
    method: "POST",
    headers: getDesktopRestAuthHeaders(),
    body: JSON.stringify({ tokens, acceptRisk: true }),
    operatorAuth: true,
    schema: githubBatchInstallResultSchema,
  });
}

export async function listPackageInstallations(kind: InstallKind = "plugin") {
  const result = await request(
    `/api/install/${kind === "world" ? "worlds" : "plugins"}`,
    {
      headers: getDesktopRestAuthHeaders(),
      operatorAuth: true,
      schema: pluginInstallationsSchema,
      silentErrors: true,
    },
  );
  return result.items;
}

export function checkGithubPackageUpdate(
  id: string,
  url?: string,
  signal?: AbortSignal,
  kind: InstallKind = "plugin",
) {
  return request(`/api/install/${kind}/github/update/preview`, {
    method: "POST",
    headers: getDesktopRestAuthHeaders(),
    operatorAuth: true,
    body: JSON.stringify({ id, ...(url ? { url } : {}) }),
    signal,
    silentErrors: true,
    schema: githubPluginUpdateCheckSchema,
  });
}
export function updateGithubPackage(
  token: string,
  kind: InstallKind = "plugin",
): Promise<InstallResult> {
  return request(`/api/install/${kind}/github/update`, {
    method: "POST",
    headers: getDesktopRestAuthHeaders(),
    operatorAuth: true,
    body: JSON.stringify({ token, acceptRisk: true }),
    schema: installResultSchema,
  });
}
export function cancelGithubPackageUpdate(
  id: string,
  kind: InstallKind = "plugin",
) {
  return request(
    `/api/install/${kind}/github/update/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: getDesktopRestAuthHeaders(),
      operatorAuth: true,
      schema: z.object({ ok: z.literal(true) }).strict(),
    },
  );
}
