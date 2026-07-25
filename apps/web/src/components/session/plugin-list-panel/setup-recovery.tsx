import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import {
  retrySetupRuntime,
  waiveSetupRuntime,
  type SetupRuntimeState,
} from "@/services/api.js";

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
 * renders nothing. The retry/waive response is overlaid locally so the row
 * updates immediately — the global SessionRecord catches up on the next turn's
 * natural resync, so no dedicated dispatch path is needed.
 */
export function SetupRecovery({
  pluginId,
  sessionId,
  setupRuntimes,
}: SetupRecoveryProps) {
  const { t } = useTranslation();
  const [overrides, setOverrides] = useState<Record<string, SetupRuntimeState>>(
    {},
  );
  const [pending, setPending] = useState(false);

  const states = useMemo(
    () =>
      Object.entries({ ...setupRuntimes, ...overrides }).filter(
        ([runtimeId]) => pluginIdOf(runtimeId) === pluginId,
      ),
    [setupRuntimes, overrides, pluginId],
  );
  const blockedRuntimeId = states.find(([, s]) => s.state === "blocked")?.[0];
  const isWaived = states.some(
    ([, s]) => s.state === "done" && s.resolution === "waived",
  );

  const apply = useCallback(
    (fn: typeof retrySetupRuntime) => {
      if (!sessionId || !blockedRuntimeId) return;
      setPending(true);
      void fn(sessionId, blockedRuntimeId)
        .then((res) => {
          setOverrides((prev) => ({ ...prev, [res.runtimeId]: res.state }));
        })
        .catch(() => {
          // Non-critical: the badge stays; next turn's resync reflects reality.
        })
        .finally(() => setPending(false));
    },
    [sessionId, blockedRuntimeId],
  );

  if (blockedRuntimeId) {
    return (
      <div className="w-full flex items-center gap-1.5 px-2.5 pb-2">
        <Badge
          variant="destructive"
          className="text-[9px] px-1.5 py-0 h-4 shrink-0"
        >
          {t("plugin.setupBlocked", "Setup failed")}
        </Badge>
        <button
          type="button"
          disabled={pending}
          onClick={() => apply(retrySetupRuntime)}
          className="text-[10px] leading-none px-1.5 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
        >
          {t("plugin.setupRetry", "Retry")}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => apply(waiveSetupRuntime)}
          className="text-[10px] leading-none px-1.5 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
        >
          {t("plugin.setupWaive", "Skip this step")}
        </button>
      </div>
    );
  }
  if (isWaived) {
    return (
      <span className="w-full px-2.5 pb-2 text-[10px] text-muted-foreground italic">
        {t("plugin.setupWaived", "Running in degraded mode")}
      </span>
    );
  }
  return null;
}
