import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import type { SetupRuntimeState } from "@/services/api.js";
import { useSessionActions } from "@/stores/session-store.js";

/** The pluginId owning a runtimeId (`"<pluginId>/<name>"`, or the id itself). */
function pluginIdOf(runtimeId: string): string {
  return runtimeId.split("/")[0] || runtimeId;
}

interface SetupRecoveryProps {
  pluginId: string;
  sessionId?: string;
  setupRuntimes?: Record<string, SetupRuntimeState>;
}

/**
 * Blocked-setup recovery row for a plugin. When one of the plugin's one-time
 * setup runtimes is `blocked`, shows a status badge plus Retry / Skip buttons;
 * when a setup runtime was waived, shows a degraded-mode note; otherwise
 * renders nothing. Recovery persists through the session workspace before
 * updating the global SessionRecord.
 */
export function SetupRecovery({
  pluginId,
  sessionId,
  setupRuntimes,
}: SetupRecoveryProps) {
  const { t } = useTranslation();

  const states = useMemo(
    () =>
      Object.entries(setupRuntimes ?? {}).filter(
        ([runtimeId]) => pluginIdOf(runtimeId) === pluginId,
      ),
    [setupRuntimes, pluginId],
  );
  const blockedRuntimeId = states.find(([, s]) => s.state === "blocked")?.[0];
  const isWaived = states.some(
    ([, s]) => s.state === "done" && s.resolution === "waived",
  );

  if (blockedRuntimeId) {
    return (
      <BlockedSetupRecovery
        sessionId={sessionId}
        runtimeId={blockedRuntimeId}
      />
    );
  }
  if (isWaived) {
    return (
      <span className="w-full px-2.5 pb-2 text-xs text-muted-foreground italic">
        {t("plugin.setupWaived", "Running in degraded mode")}
      </span>
    );
  }
  return null;
}

function BlockedSetupRecovery({
  sessionId,
  runtimeId,
}: {
  sessionId?: string;
  runtimeId: string;
}) {
  const { t } = useTranslation();
  const { resolveSetupRuntime } = useSessionActions();
  const [pending, setPending] = useState(false);

  const apply = useCallback(
    (resolution: "retry" | "waive") => {
      if (!sessionId) return;
      setPending(true);
      void resolveSetupRuntime(sessionId, runtimeId, resolution)
        .catch(() => {
          // Keep the blocked state visible so the user can retry.
        })
        .finally(() => setPending(false));
    },
    [sessionId, runtimeId, resolveSetupRuntime],
  );

  return (
    <div className="w-full flex items-center gap-1.5 px-2.5 pb-2">
      <Badge variant="destructive" className="text-xs px-1.5 py-0 h-4 shrink-0">
        {t("plugin.setupBlocked", "Setup failed")}
      </Badge>
      <button
        type="button"
        disabled={pending}
        onClick={() => apply("retry")}
        className="text-xs leading-none px-1.5 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
      >
        {t("plugin.setupRetry", "Retry")}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => apply("waive")}
        className="text-xs leading-none px-1.5 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
      >
        {t("plugin.setupWaive", "Skip this step")}
      </button>
    </div>
  );
}
