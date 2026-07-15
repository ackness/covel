import i18n from "@/i18n/index.js";
import type { SessionPluginInfo } from "@/services/api.js";
import { resolveMediaSrc } from "@/lib/media-resolve.js";
import { emitToast } from "@/lib/toast-channel.js";
import { compactJobId } from "@/lib/job-ui.js";
import { FrameworkRuntimeCapability } from "@covel/shared";
import type { MediaRef } from "@covel/shared";
import { postPluginRpcWithApproval } from "../plugin-rpc-ui.js";
import type { ImagePromptPayload } from "./image-records.js";

// Discover the image-generator runtime by capability rather than baking in a
// runtime-name convention. The contract: any plugin that ships an image
// generator runtime tags it with the `image-generator` capability — same shape
// as the `image-prompt` discovery used in chat-messages.tsx. Both tags live in
// FrameworkRuntimeCapability so a typo is a compile error, not a silent miss.
export function findImageGeneratorRuntimeId(
  plugin: SessionPluginInfo | undefined,
): string | null {
  if (!plugin) return null;
  const rt = plugin.runtimes?.find((r) =>
    r.capabilities?.includes(FrameworkRuntimeCapability.ImageGenerator),
  );
  return rt?.id ?? null;
}

async function triggerImageFromPrompt(
  sessionId: string | undefined,
  pluginId: string,
  runtimeId: string | null,
  payload: ImagePromptPayload,
): Promise<void> {
  if (!sessionId) throw new Error("session unavailable");
  if (!runtimeId) {
    throw new Error(
      `plugin ${pluginId} has no runtime declaring \`${FrameworkRuntimeCapability.ImageGenerator}\` capability`,
    );
  }
  const req = { pluginId, runtimeId, payload };
  const res = await postPluginRpcWithApproval({
    sessionId,
    request: req,
    pluginId,
    actionLabel: `runtime ${runtimeId}`,
    confirm: async ({ message }) => window.confirm(message),
    t: (key, options) => i18n.t(key, options),
  });
  if (!res) return;
  if (res.status === "accepted") {
    emitToast(
      "info",
      i18n.t("coreImage.panel.rerunSubmitted", {
        id: compactJobId(res.jobId),
      }),
    );
    return;
  }
  if (res.status === "error") throw new Error(res.error);
  if (res.status !== "ok") return;
  const failed = res.runtimeResults?.find(
    (r) => r.status === "failed" || r.error,
  )?.error;
  if (failed || res.abortReason)
    throw new Error(failed ?? res.abortReason ?? "image generation failed");
  emitToast("info", i18n.t("coreImage.panel.rerunSubmittedSimple"));
}

async function downloadRef(
  ref: MediaRef,
  sessionId: string | undefined,
  filename: string,
): Promise<void> {
  if (!sessionId) throw new Error("session unavailable");
  const resolved = await resolveMediaSrc(ref, { sessionId });
  if (!resolved.ok || !resolved.url) throw new Error("media unavailable");
  const a = document.createElement("a");
  a.href = resolved.url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function showActionError(err: unknown): void {
  emitToast("error", err instanceof Error ? err.message : String(err));
}

export function rerunImagePrompt(args: {
  readonly sessionId: string | undefined;
  readonly pluginId: string;
  readonly runtimeId: string | null;
  readonly payload: ImagePromptPayload;
}): void {
  void triggerImageFromPrompt(
    args.sessionId,
    args.pluginId,
    args.runtimeId,
    args.payload,
  ).catch(showActionError);
}

export function downloadImage(args: {
  readonly ref: MediaRef;
  readonly sessionId: string | undefined;
  readonly filename: string;
}): void {
  void downloadRef(args.ref, args.sessionId, args.filename).catch(
    showActionError,
  );
}
