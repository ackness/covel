import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { resumeSessionPluginFault } from "@/services/api.js";
import { useSessionActions } from "@/stores/session-store.js";
import { emitToast } from "@/lib/toast-channel.js";

export function FaultRecovery({
  sessionId,
  pluginId,
  executing,
}: {
  sessionId?: string;
  pluginId: string;
  executing?: boolean;
}) {
  const { t } = useTranslation();
  const { loadSessionPlugins } = useSessionActions();
  const [pending, setPending] = useState(false);
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1">
      <Badge variant="destructive">{t("plugin.faultPaused")}</Badge>
      <button
        type="button"
        disabled={!sessionId || pending || executing}
        className="text-xs px-1.5 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
        onClick={() => {
          if (!sessionId) return;
          setPending(true);
          void resumeSessionPluginFault(sessionId, pluginId)
            .then(() => loadSessionPlugins())
            .catch(() => emitToast("error", t("plugin.resumeFaultFailed")))
            .finally(() => setPending(false));
        }}
      >
        {t("plugin.resumeFault")}
      </button>
    </div>
  );
}
