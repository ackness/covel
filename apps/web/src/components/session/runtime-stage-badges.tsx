import { useTranslation } from "react-i18next";
import { stageRank, type Stage } from "@covel/shared";
import { Badge } from "@/components/ui/badge.js";
import { stageLabel } from "@/lib/stage-label.js";

export function RuntimeStageBadges({
  runtimes,
}: {
  runtimes: readonly { stage?: Stage }[];
}) {
  const { t } = useTranslation();
  const stages = [
    ...new Set(
      runtimes.flatMap((runtime) => (runtime.stage ? [runtime.stage] : [])),
    ),
  ].sort((a, b) => stageRank(a) - stageRank(b));
  return (
    <span className="inline-flex flex-wrap gap-1">
      {stages.map((stage) => (
        <Badge
          key={stage}
          variant="outline"
          className="ui-chip shrink-0 text-xs"
        >
          {stageLabel(stage, t)}
        </Badge>
      ))}
    </span>
  );
}
