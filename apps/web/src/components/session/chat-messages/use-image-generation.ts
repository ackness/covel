import { useCallback, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import type { PluginRpcRequest } from "@covel/shared";
import type { SessionPluginInfo } from "@/services/api.js";
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
  readonly sessionPlugins: SessionPluginInfo[];
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

  const imageGenEntry = useMemo<ImageGenEntry | null>(() => {
    for (const p of sessionPlugins) {
      if (!p.isActive) continue;
      if (!p.capabilities?.includes("image-generation")) continue;
      const entry = p.runtimes?.find(
        (r) =>
          r.trigger?.type === "manual" &&
          r.capabilities?.includes("image-prompt"),
      );
      if (entry) return { pluginId: p.id, runtimeId: entry.id };
    }
    return null;
  }, [sessionPlugins]);

  // Use plugin-rpc rather than `triggerEvent`. Firing a kernel event would
  // create a fresh turn just to route the topic; plugin-rpc invokes the entry
  // runtime in-place and lets the framework dispatch its background follower
  // (image generator) without inflating the turn counter. The plugin's right-
  // panel button uses the same pattern — keep them aligned.
  const handleGenerateImage = useCallback(async () => {
    if (!sessionId || !imageGenEntry || generatingImage) return;
    const req = {
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
