/**
 * Asset output enforcement
 *
 * Internal module split from session-kernel.ts. Keep public imports routed
 * through session-kernel.ts unless a caller intentionally needs this boundary.
 */

import { isAssetGeneratePayload } from "@covel/shared";
import type { Proposal } from "@covel/shared";
import type { KernelStore } from "./session-commit-pipeline.js";
import { makeProposal } from "./session-kernel-helpers.js";

export async function enforceImageAssetOutput(
  result: {
    pluginId: string;
    runtimeId: string;
    turnId: string;
    status: string;
    output: Record<string, unknown> | null;
  },
  store: KernelStore,
  sessionId: string,
  proposals: readonly Proposal[],
  capabilities: readonly string[] | undefined,
): Promise<{ proposal: Proposal; error: string } | null> {
  if (!capabilities?.includes("image-generation")) return null;
  if (isPendingAssetOutput(result.output)) return null;

  const hasAssetGenerate = proposals.some(
    (proposal) =>
      proposal.type === "asset.generate" &&
      isAssetGeneratePayload(proposal.payload),
  );
  if (hasAssetGenerate) return null;

  const message = "image.generate.asset_missing";
  await writeImageGenerationErrorLog(store, sessionId, result, message, {
    proposalCount: proposals.length,
  });

  return {
    proposal: makeProposal(
      "asset.generate",
      { pluginId: result.pluginId, runtimeId: result.runtimeId },
      result.turnId,
      sessionId,
      { error: message, proposalCount: proposals.length },
    ),
    error: message,
  };
}

export async function enforceImagePluginDataRefs(
  result: {
    pluginId: string;
    runtimeId: string;
    turnId: string;
    status: string;
    output: Record<string, unknown> | null;
  },
  store: KernelStore,
  sessionId: string,
  proposals: readonly Proposal[],
  capabilities: readonly string[] | undefined,
): Promise<Array<{ proposal: Proposal; error: string }>> {
  if (!capabilities?.includes("image-generation")) return [];

  const offenders = proposals.filter(hasInlineImagePluginData);
  if (offenders.length === 0) return [];

  const message = "image.generate.plugin_data_inline_media";
  await writeImageGenerationErrorLog(store, sessionId, result, message, {
    proposalIds: offenders.map((proposal) => proposal.id),
  });

  return offenders.map((proposal) => ({
    proposal,
    error: message,
  }));
}

async function writeImageGenerationErrorLog(
  store: KernelStore,
  sessionId: string,
  result: {
    pluginId: string;
    runtimeId: string;
    turnId: string;
  },
  message: string,
  extraMeta: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const key = `${now.getTime().toString(36).padStart(9, "0")}-${crypto.randomUUID().slice(0, 8)}`;
  const value = {
    level: "error",
    message,
    meta: {
      pluginId: result.pluginId,
      runtimeId: result.runtimeId,
      turnId: result.turnId,
      ...extraMeta,
    },
    turnId: result.turnId,
    runtimeId: result.runtimeId,
    timestamp: nowIso,
  };

  if (store.setPluginData) {
    try {
      await store.setPluginData({
        id: `${sessionId}:${result.pluginId}:_logs:${key}`,
        sessionId,
        pluginId: result.pluginId,
        namespace: "_logs",
        key,
        value,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      return;
    } catch {
      // Fall through to console error so the failed output remains visible.
    }
  }

  console.error(
    "[session-kernel] %s for runtime %s (session %s, turn %s)",
    message,
    result.runtimeId,
    sessionId,
    result.turnId,
  );
}

function isPendingAssetOutput(output: Record<string, unknown> | null): boolean {
  const status =
    typeof output?.status === "string" ? output.status.toLowerCase() : "";
  return (
    status === "pending" ||
    status === "queued" ||
    status === "running" ||
    status === "processing" ||
    status === "in_progress"
  );
}

function hasInlineImagePluginData(proposal: Proposal): boolean {
  if (proposal.type === "plugin.data") {
    return isInlineImagePluginDataItem(proposal.payload);
  }
  if (proposal.type !== "plugin.data.batch") return false;

  const payload = proposal.payload as { items?: unknown };
  if (!Array.isArray(payload.items)) return false;
  return payload.items.some((item) => isInlineImagePluginDataItem(item));
}

function isInlineImagePluginDataItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const payload = item as { namespace?: unknown; value?: unknown };
  if (payload.namespace !== "images") return false;
  return containsInlineMediaField(payload.value);
}

function containsInlineMediaField(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (looksLikeMediaRef(value)) return false;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "ref" && looksLikeMediaRef(child)) continue;
    if (
      (key === "base64" || key === "dataUrl" || key === "url") &&
      typeof child === "string" &&
      child.length > 0
    ) {
      return true;
    }
    if (containsInlineMediaField(child, seen)) return true;
  }
  return false;
}

function looksLikeMediaRef(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.id === "string" &&
    ref.id.length > 0 &&
    typeof ref.mime === "string" &&
    ref.mime.length > 0 &&
    typeof ref.size === "number" &&
    Number.isFinite(ref.size)
  );
}
