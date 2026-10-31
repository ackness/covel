import type { PluginRuntimeSummary } from "@covel/shared";
import { useTranslation } from "react-i18next";

/** Model use is information at selection time, independent of code authorization. */
export function PluginModelNotice({
  runtimes,
  className,
}: {
  runtimes: readonly PluginRuntimeSummary[];
  className?: string;
}) {
  const { t } = useTranslation();
  const modelRuntimes = runtimes.filter(
    (runtime) => runtime.runtimeType === "agent" || runtime.model,
  );
  if (!modelRuntimes.length) return null;
  const schedules = modelRuntimes.map((runtime) => {
    const trigger = runtime.trigger;
    let schedule = runtime.subagentOnly
      ? t("plugin.modelUse.delegated")
      : trigger.type === "manual"
        ? t("plugin.modelUse.manual")
        : trigger.type === "event"
          ? t("plugin.modelUse.event")
          : runtime.stage === "setup"
            ? t("plugin.modelUse.setup")
            : t("plugin.modelUse.scheduled", { count: trigger.every ?? 1 });
    if (
      !runtime.subagentOnly &&
      trigger.type === "auto" &&
      runtime.stage !== "setup"
    ) {
      if (trigger.startTurn !== undefined)
        schedule += ` ${t("plugin.modelUse.start", { count: trigger.startTurn })}`;
      if (trigger.cooldownTurns !== undefined)
        schedule += ` ${t("plugin.modelUse.cooldown", { count: trigger.cooldownTurns })}`;
      if (trigger.maxTriggerCount !== undefined)
        schedule += ` ${t("plugin.modelUse.limit", { count: trigger.maxTriggerCount })}`;
    }
    return schedule;
  });
  return (
    <p className={className} data-testid="plugin-model-notice">
      {t("plugin.modelUse.notice")} {[...new Set(schedules)].join(" ")}
    </p>
  );
}
