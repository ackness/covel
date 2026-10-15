import type { TFunction } from "i18next";
import type { WorldRecord } from "@/services/api.js";

export function WorldUpdateBadge({
  world,
  t,
  className = "",
}: {
  world: WorldRecord;
  t: TFunction;
  className?: string;
}) {
  if (!world.updateAvailable) return null;
  return (
    <span
      className={`ui-tag w-fit border-border bg-card text-foreground ${className}`}
      title={t("world.packageUpdateHint")}
    >
      {t("world.updateAvailable")}
    </span>
  );
}
