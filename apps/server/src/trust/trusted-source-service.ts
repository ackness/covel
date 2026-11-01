import { rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  computePluginCapabilities,
  packageHasServerCode,
  assessPluginExecution,
  unknownExecutionAssessment,
  readPackageInventory,
  type PluginExecutionAssessment,
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
  assessment: PluginExecutionAssessment;
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
    const entry = registry.getCurrent(pluginId);
    if (!entry || entry.source !== "community" || !entry.rootPath) return;
    try {
      const signature = await packageStatSignature(entry.rootPath);
      const cached = results.get(pluginId);
      if (cached?.entry === entry && cached.signature === signature) return;
      results.delete(pluginId);
      const inventory = await readPackageInventory(entry.rootPath).catch(
        () => undefined,
      );
      const result = await checkPackageIntegrity(
        entry.rootPath,
        inventory?.files,
      );
      // Do not cache a digest assembled while the directory was changing.
      const after = await packageStatSignature(entry.rootPath);
      const stable = signature === after;
      if (!stable) result.status = "modified";
      const root = entry.packageManifest;
      const runtimes = entry.manifests ?? [];
      const bound =
        stable &&
        inventory !== undefined &&
        inventory.digest === entry.executionAssessment?.digest;
      let assessment =
        stable && root && inventory
          ? assessPluginExecution({
              files: inventory.files,
              directories: inventory.directories,
              root,
              runtimes,
            })
          : unknownExecutionAssessment();
      // New files cannot authorize an old parsed definition, even when both
      // versions contain only data. Reload publishes the matching definition.
      if (!bound && assessment.mode === "declarative")
        assessment = unknownExecutionAssessment();
      const hasServerCode = packageHasServerCode(assessment);
      const capabilities =
        root && bound
          ? computePluginCapabilities({ root, runtimes, hasServerCode })
          : undefined;
      if (registry.getCurrent(pluginId) !== entry) return;
      results.set(pluginId, {
        ...result,
        entry,
        signature: stable && inventory ? after : undefined,
        hasServerCode,
        capabilities,
        assessment,
      });
      if (result.status === "unreadable")
        console.warn(`[trusted-sources] Cannot read package ${pluginId}`);
    } catch (error) {
      if (registry.getCurrent(pluginId) === entry)
        results.set(pluginId, {
          entry,
          status: "unreadable",
          assessment: unknownExecutionAssessment(),
        });
      console.warn(
        `[trusted-sources] Verification failed for ${pluginId}:`,
        error,
      );
    }
  }
  async function ensureFresh(pluginId: string): Promise<void> {
    // Publication may replace an entry while another request inspects it.
    // Join that inspection, then inspect the replacement instead of reusing it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let work = pending.get(pluginId);
      if (!work) {
        work = refresh(pluginId);
        pending.set(pluginId, work);
      }
      try {
        await work;
      } finally {
        if (pending.get(pluginId) === work) pending.delete(pluginId);
      }
      if (results.get(pluginId)?.entry === registry.getCurrent(pluginId))
        return;
    }
  }
  function current(pluginId: string): VerifiedPackage | undefined {
    const entry = registry.getCurrent(pluginId);
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
  function executionMode(pluginId: string): PluginExecutionAssessment["mode"] {
    return current(pluginId)?.assessment.mode ?? "unknown";
  }
  function isDeclarative(pluginId: string): boolean {
    // A frozen code-era registry cannot borrow a newer content-only exemption.
    // Its tools/services still refer to executable registrations from that era.
    return (
      executionMode(pluginId) === "declarative" &&
      registry.get(pluginId)?.executionAssessment?.mode === "declarative"
    );
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
    // Another package's awaited activation can republish an earlier entry.
    // Finish against live publications, with the same bounded retry as admission.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const entries = [...registry.getAll().values()].filter(
        (entry) => entry.source === "community" && entry.rootPath,
      );
      for (const entry of entries) await ensureFresh(entry.id);
      if (
        entries.every(
          (entry) =>
            results.get(entry.id)?.entry === registry.getCurrent(entry.id),
        )
      )
        return;
    }
  }
  return {
    policy,
    verifyAll,
    ensureFresh,
    implicitGrant,
    executionMode,
    executionDiagnostics: (pluginId: string) =>
      current(pluginId)?.assessment.diagnostics ??
      unknownExecutionAssessment().diagnostics,
    isDeclarative,
    summary,
    recordSnapshot,
  };
}
