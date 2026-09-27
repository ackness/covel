import { useCallback, useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { mediaImageFlowSchema } from "@covel/shared";
import { request } from "@/services/api/request.js";
import type { PluginRpcRequest } from "@covel/shared";
import type { SessionPlugin } from "@/services/api.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  emitPluginRpcRuntimeResponse,
  postPluginRpcWithApproval,
  type ConfirmPluginRpcApproval,
} from "../plugin-rpc-ui.js";

interface ImageGenEntry {
  readonly pluginId: string;
  readonly runtimeId: string;
}

interface UseImageGenerationArgs {
  readonly sessionPlugins: SessionPlugin[];
  readonly sessionId: string | undefined;
  readonly confirm: ConfirmPluginRpcApproval;
  readonly t: TFunction;
}

interface UseImageGenerationResult {
  readonly isImageGenActive: boolean;
  readonly generatingImage: boolean;
  readonly handleGenerateImage: () => Promise<void>;
}

/**
 * Discovers the image-gen entry runtime by capability + trigger so framework
 * code never names a specific plugin or runtime. An entry runtime is one with
 * capability `image-prompt` and a manual trigger — the contract authors follow
 * when wiring a multi-step image plugin (prompt generator → image generator
 * chained via a background follower).
 */
export function useImageGeneration({
  sessionPlugins,
  sessionId,
  confirm,
  t,
}: UseImageGenerationArgs): UseImageGenerationResult {
  const [generatingImage, setGeneratingImage] = useState(false);

  const [imageGenEntry, setImageGenEntry] = useState<ImageGenEntry | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    setImageGenEntry(null);
    if (!sessionId) return;
    void request<{ flow: unknown }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/media/image-flow`,
    )
      .then(({ flow }) => {
        const parsed = mediaImageFlowSchema.safeParse(flow);
        if (
          live &&
          parsed.success &&
          parsed.data.pluginId &&
          sessionPlugins.some((p) => p.id === parsed.data.pluginId && p.active)
        )
          setImageGenEntry({
            pluginId: parsed.data.pluginId,
            runtimeId: parsed.data.entryRuntimeId,
          });
      })
      .catch(() => {
        if (live) setImageGenEntry(null);
      });
    return () => {
      live = false;
    };
  }, [sessionId, sessionPlugins]);

  // Use plugin-rpc rather than `triggerEvent`. Firing a kernel event would
  // create a fresh turn just to route the topic; plugin-rpc invokes the entry
  // runtime in-place and lets the framework dispatch its background follower
  // (image generator) without inflating the turn counter. The plugin's right-
  // panel button uses the same pattern — keep them aligned.
  const handleGenerateImage = useCallback(async () => {
    if (!sessionId || !imageGenEntry || generatingImage) return;
    const req = {
      kind: "runtime",
      pluginId: imageGenEntry.pluginId,
      runtimeId: imageGenEntry.runtimeId,
      expectsBackgroundFollower: true,
    } satisfies PluginRpcRequest;
    setGeneratingImage(true);
    try {
      const res = await postPluginRpcWithApproval({
        sessionId,
        request: req,
        pluginId: imageGenEntry.pluginId,
        actionLabel: `runtime ${imageGenEntry.runtimeId}`,
        confirm,
        t,
      });
      if (res) {
        emitPluginRpcRuntimeResponse({
          response: res,
          t,
          runtimeId: imageGenEntry.runtimeId,
          expectsBackgroundFollower: true,
          fallbackFailureMessage: t(
            "coreImage.generationFailed",
            "Image generation failed",
          ),
        });
      }
    } catch (err) {
      emitToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingImage(false);
    }
  }, [sessionId, imageGenEntry, generatingImage, confirm, t]);

  return {
    isImageGenActive: imageGenEntry !== null,
    generatingImage,
    handleGenerateImage,
  };
}
