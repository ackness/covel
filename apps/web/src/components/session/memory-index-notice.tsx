import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionMemoryIndexStatus } from "@covel/shared";
import {
  getSessionMemoryIndex,
  rebuildSessionMemoryIndex,
} from "@/services/api";
import { ApiError } from "@/services/api/request.js";
import { useNotice } from "@/lib/notice-center.js";
import { useSetting } from "@/settings/use-settings.js";

function modelLabel(model: {
  readonly provider: string;
  readonly modelName: string;
}): string {
  return model.provider
    ? `${model.provider}/${model.modelName}`
    : model.modelName;
}

function failureReason(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details as { reason?: unknown } | undefined;
    if (typeof details?.reason === "string") return details.reason;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The session's memory was indexed with an embedding model the settings no
 * longer select: memory search matches keywords only until the index is
 * rebuilt with the configured model (or cleared when none is configured).
 */
export function MemoryIndexNotice({
  sessionId,
  refreshKey,
}: {
  sessionId: string;
  /** Changing it checks again, e.g. after the model settings were closed. */
  refreshKey?: unknown;
}): null {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SessionMemoryIndexStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [developerView] = useSetting<boolean>("ui.developerView");

  useEffect(() => {
    let current = true;
    setError(null);
    getSessionMemoryIndex(sessionId).then(
      (next) => {
        if (current) setStatus(next);
      },
      () => {
        // A server without the session (browser-private play) or without a
        // vector index has nothing to report.
        if (current) setStatus(null);
      },
    );
    return () => {
      current = false;
    };
  }, [sessionId, refreshKey]);

  const locked =
    status?.stale && status.locked ? modelLabel(status.locked) : null;
  const configured = status?.configured ? modelLabel(status.configured) : null;

  const rebuild = () => {
    setBusy(true);
    setError(null);
    rebuildSessionMemoryIndex(sessionId)
      .then(setStatus, (cause: unknown) => setError(failureReason(cause)))
      .finally(() => setBusy(false));
  };

  // Clearing the index is a developer tool; players only rebuild.
  const action = configured
    ? {
        label: busy
          ? t("session.memoryIndex.rebuilding")
          : t("session.memoryIndex.rebuild"),
        onClick: rebuild,
        disabled: busy,
      }
    : developerView
      ? {
          label: busy
            ? t("session.memoryIndex.rebuilding")
            : t("session.memoryIndex.clear"),
          onClick: rebuild,
          disabled: busy,
        }
      : null;

  useNotice(
    locked === null
      ? null
      : {
          key: "memory-index",
          kind: "card",
          tone: "warning",
          scope: sessionId,
          title: t("session.memoryIndex.staleTitle"),
          body: [
            configured
              ? t("session.memoryIndex.staleDetail", { locked, configured })
              : t("session.memoryIndex.noModelDetail", { locked }),
            ...(error
              ? [t("session.memoryIndex.failed", { reason: error })]
              : []),
          ].join("\n"),
          ...(action ? { actions: [action] } : {}),
        },
  );
  return null;
}
