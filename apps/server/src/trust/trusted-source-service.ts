import { rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  computePluginCapabilities,
  packageHasServerCode,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import {
  capabilitiesWithin,
  normalizeTrustedSources,
  resolveServerSetting,
  TRUSTED_SOURCES_SERVER_SETTING,
  TRUSTED_SOURCES_SETTING_KEY,
  trustedSourceMatches,
  trustedSourcesFromEnv,
  readEnvString,
  type PluginCapabilities,
  type PluginSourceTrust,
} from "@covel/shared";
import type { ServerSettings } from "../lib/server-settings.js";
import {
  checkPackageIntegrity,
  withPackageMutation,
  type PackageIntegrityResult,
} from "../routes/api/install/package-files.js";
import { INSTALL_RECEIPT_FILE } from "../routes/api/install/shared.js";
import { packageStatSignature } from "./package-signature.js";

interface VerifiedPackage extends PackageIntegrityResult {
  entry: PluginRegistryEntry;
  signature?: string;
  capabilities?: PluginCapabilities;
  hasServerCode?: boolean;
}
export type TrustedSourceService = ReturnType<
  typeof createTrustedSourceService
>;
export function createTrustedSourceService({
  settings,
  registry,
  pluginsRoot,
}: {
  settings: ServerSettings;
  registry: PluginRegistry;
  pluginsRoot: string;
}) {
  const results = new Map<string, VerifiedPackage>();
  const pending = new Map<string, Promise<void>>();
  if (
    readEnvString("COVEL_TRUSTED_SOURCES") !== undefined &&
    trustedSourcesFromEnv() === undefined
  )
    console.warn(
      "[trusted-sources] Invalid COVEL_TRUSTED_SOURCES; ignoring the whole value",
    );
  function policy(): string[] {
    const { value } = resolveServerSetting(
      TRUSTED_SOURCES_SERVER_SETTING,
      settings.playerWritable
        ? settings.stored(TRUSTED_SOURCES_SETTING_KEY)
        : undefined,
    );
    return normalizeTrustedSources(
      TRUSTED_SOURCES_SERVER_SETTING.schema.parse(value),
    );
  }
  registry.onChange((event) => {
    if (event.type === "plugin-registered") results.delete(event.pluginId);
  });
  async function refresh(pluginId: string): Promise<void> {
    const entry = registry.get(pluginId);
    if (!entry || entry.source !== "community" || !entry.rootPath) return;
    try {
      const signature = await packageStatSignature(entry.rootPath);
      const cached = results.get(pluginId);
      if (cached?.entry === entry && cached.signature === signature) return;
      results.delete(pluginId);
      const result = await checkPackageIntegrity(entry.rootPath);
      // Do not cache a digest assembled while the directory was changing.
      const after = await packageStatSignature(entry.rootPath);
      if (signature !== after) result.status = "modified";
      const root = entry.packageManifest;
      const runtimes = entry.manifests ?? [];
      const hasServerCode =
        root && result.files
          ? packageHasServerCode(result.files, root, runtimes)
          : undefined;
      const capabilities =
        root && hasServerCode !== undefined
          ? computePluginCapabilities({ root, runtimes, hasServerCode })
          : undefined;
      if (registry.get(pluginId) !== entry) return;
      results.set(pluginId, {
        ...result,
        entry,
        signature: after,
        hasServerCode,
        capabilities,
      });
      if (result.status === "unreadable")
        console.warn(`[trusted-sources] Cannot read package ${pluginId}`);
    } catch (error) {
      if (registry.get(pluginId) === entry)
        results.set(pluginId, { entry, status: "unreadable" });
      console.warn(
        `[trusted-sources] Verification failed for ${pluginId}:`,
        error,
      );
    }
  }
  async function ensureFresh(pluginId: string): Promise<void> {
    const existing = pending.get(pluginId);
    if (existing) {
      await existing;
      return;
    }
    const work = refresh(pluginId);
    pending.set(pluginId, work);
    try {
      await work;
    } finally {
      if (pending.get(pluginId) === work) pending.delete(pluginId);
    }
  }
  function current(pluginId: string): VerifiedPackage | undefined {
    const entry = registry.get(pluginId);
    const result = results.get(pluginId);
    return entry?.source === "community" && result?.entry === entry
      ? result
      : undefined;
  }
  function implicitGrant({ pluginId }: { pluginId: string }): boolean {
    try {
      const result = current(pluginId);
      return Boolean(
        result?.status === "verified" &&
        result.receipt?.capabilities &&
        result.capabilities &&
        trustedSourceMatches(policy(), result.receipt.source.repository) &&
        capabilitiesWithin(result.capabilities, result.receipt.capabilities),
      );
    } catch {
      return false;
    }
  }
  function summary(pluginId: string): PluginSourceTrust {
    const result = current(pluginId);
    const source = result?.receipt?.source.repository ?? null;
    return {
      source,
      trustedSource: source !== null && trustedSourceMatches(policy(), source),
      integrity: result?.status ?? "unreadable",
      autoApproved: implicitGrant({ pluginId }),
    };
  }
  async function recordSnapshot(pluginId: string): Promise<void> {
    await withPackageMutation(
      pluginId,
      async () => {
        // Recheck under the install/update/uninstall lock before rewriting metadata.
        results.delete(pluginId);
        await ensureFresh(pluginId);
        const result = current(pluginId);
        if (
          result?.status !== "verified" ||
          !result.receipt ||
          !result.capabilities ||
          !result.entry.rootPath ||
          !trustedSourceMatches(policy(), result.receipt.source.repository)
        )
          return;
        const filename = path.join(result.entry.rootPath, INSTALL_RECEIPT_FILE);
        const temp = `${filename}.${randomUUID()}.tmp`;
        const receipt = {
          ...result.receipt,
          capabilities: result.capabilities,
        };
        try {
          await writeFile(temp, JSON.stringify(receipt, null, 2) + "\n", {
            flag: "wx",
            mode: 0o600,
          });
          await rename(temp, filename);
        } finally {
          await rm(temp, { force: true });
          results.delete(pluginId);
        }
        await ensureFresh(pluginId);
      },
      pluginsRoot,
    );
  }
  async function verifyAll(): Promise<void> {
    for (const entry of registry.getAll().values()) {
      if (entry.source === "community" && entry.rootPath)
        await ensureFresh(entry.id);
    }
  }
  return {
    policy,
    verifyAll,
    ensureFresh,
    implicitGrant,
    summary,
    recordSnapshot,
  };
}
