import { Cpu, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import type * as api from "@/services/api.js";
import type { UseRuntimeBindingsResult } from "@/hooks/use-runtime-bindings.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";

interface ExecutionFlowPreviewProps {
  flowData: api.PluginFlowResponse | null;
  selectedFlowSteps: api.PluginFlowStep[];
  bindingState: UseRuntimeBindingsResult;
}

export function ExecutionFlowPreview({
  flowData,
  selectedFlowSteps,
  bindingState,
}: ExecutionFlowPreviewProps) {
  const { t, i18n } = useTranslation();

  if (selectedFlowSteps.length === 0) return null;

  return (
    <div className="space-y-2 pt-2 border-t border-dashed border-border">
      <div className="space-y-0.5">
        <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
          <Zap className="w-3 h-3" />
          {t("session.executionFlow", "Execution Flow")}
        </h4>
        <p
          className="text-[10px] text-muted-foreground/70 leading-snug"
          title={t(
            "session.executionFlowTitle",
            "Plugins run stage by stage each turn: setup, then pre-turn, narrative, and post-turn.",
          )}
        >
          {t(
            "session.executionFlowHint",
            "Turn order — earlier stages run first.",
          )}
        </p>
      </div>
      <div className="space-y-1">
        {(flowData?.segments ?? []).map((segment) => {
          // Group by stage segment (segmentId), not priority range.
          const stepsInSegment = selectedFlowSteps
            .filter((step) => step.segmentId === segment.id)
            .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
          if (stepsInSegment.length === 0) return null;
          return (
            <div key={segment.id}>
              <div className="text-[9px] text-muted-foreground/70 uppercase tracking-widest mb-0.5">
                {resolveI18n(segment.labelText, i18n.language) || segment.label}
              </div>
              <div className="flex flex-wrap gap-1">
                {stepsInSegment.map((step) => {
                  const bindingEntry = bindingState.entries.find(
                    (entry) =>
                      entry.qualifiedId === step.runtimeId ||
                      entry.qualifiedId === step.pluginId,
                  );
                  return (
                    <div
                      key={step.runtimeId}
                      className="inline-flex items-center gap-1.5 bg-muted/40 border border-border px-2 py-1 text-[10px]"
                      title={`${step.runtimeId} — ${step.trigger.type}`}
                    >
                      <span className="font-medium truncate max-w-30">
                        {step.label}
                      </span>
                      {step.runtimeType === "agent" && (
                        <Cpu className="w-2.5 h-2.5 text-muted-foreground" />
                      )}
                      {bindingEntry?.slotName && (
                        <Badge
                          variant="outline"
                          className="text-[8px] px-1 py-0 h-3"
                        >
                          {bindingEntry.slotName}
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
