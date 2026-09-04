import { Puzzle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent } from "@/components/ui/card.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import type { UseRuntimeBindingsResult } from "@/hooks/use-runtime-bindings.js";
import {
  textValue,
  type PluginGroup,
  type PluginPack,
} from "@/lib/session-plugin-selection.js";
import type * as api from "@/services/api.js";
import { CollapsibleCardHeader } from "./collapsible-card-header.js";
import { ExecutionFlowPreview } from "./execution-flow-preview.js";
import { PluginFilterBar } from "./plugin-filter-bar.js";
import { PluginPackageRow } from "./plugin-package-row.js";
import { WorldDataPreflightPanel } from "./world-data-preflight-panel.js";
import type { PrepSectionStatus } from "./types.js";

interface PluginSelectionCardProps {
  pluginPlan: api.WorldPluginPlan | null;
  pluginPlanLoading: boolean;
  packages: api.PluginSummary[];
  selectedPluginIds: string[];
  selectedPluginIdSet: ReadonlySet<string>;
  selectedPackages: api.PluginSummary[];
  expanded: boolean;
  onToggleExpanded: () => void;
  pluginPacks: readonly PluginPack[];
  activePluginPack: PluginPack | null;
  activePluginTags: ReadonlySet<string>;
  availablePluginTags: string[];
  pluginSearch: string;
  onPluginSearchChange: (value: string) => void;
  onTogglePluginTag: (tag: string) => void;
  onApplyPack: (packId: string) => void;
  pluginGroups: PluginGroup[];
  corePluginIds: ReadonlySet<string>;
  lockedPluginIds: ReadonlySet<string>;
  bindingState: UseRuntimeBindingsResult;
  resolvedSlots: ResolvedSlot[];
  resolveDeclaredSlot: (slotId: string) => ResolvedSlot | null;
  isMissingDeclaredSlot: (slotId: string) => boolean;
  onTogglePlugin: (name: string) => void;
  worldDataPreflight: api.WorldDataPreflightResponse | null;
  worldDataPreflightStatus: PrepSectionStatus;
  worldDataPreflightError: string | null;
  onRetryWorldDataPreflight: () => void;
  flowData: api.PluginFlowResponse | null;
  selectedFlowSteps: api.PluginFlowStep[];
}

function PluginPackSelector({
  pluginPacks,
  activePluginPack,
  onApplyPack,
}: {
  pluginPacks: readonly PluginPack[];
  activePluginPack: PluginPack | null;
  onApplyPack: (packId: string) => void;
}) {
  const { i18n } = useTranslation();

  if (pluginPacks.length === 0) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
      {pluginPacks.map((pack) => {
        const isActive = activePluginPack?.id === pack.id;
        return (
          <button
            key={pack.id}
            type="button"
            className={`border px-3 py-2 text-left transition-colors ${
              isActive
                ? "border-primary/50 bg-primary/10"
                : "border-border bg-muted/20 hover:bg-muted/40"
            }`}
            onClick={() => onApplyPack(pack.id)}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold truncate">
                {textValue(pack.label, i18n.language) || pack.id}
              </span>
              <Badge
                variant={isActive ? "secondary" : "outline"}
                className="text-xs shrink-0"
              >
                {pack.pluginIds.length}
              </Badge>
            </div>
            {pack.description && (
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                {textValue(pack.description, i18n.language)}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function PluginSelectionCard({
  pluginPlan,
  pluginPlanLoading,
  packages,
  selectedPluginIds,
  selectedPluginIdSet,
  selectedPackages,
  expanded,
  onToggleExpanded,
  pluginPacks,
  activePluginPack,
  activePluginTags,
  availablePluginTags,
  pluginSearch,
  onPluginSearchChange,
  onTogglePluginTag,
  onApplyPack,
  pluginGroups,
  corePluginIds,
  lockedPluginIds,
  bindingState,
  resolvedSlots,
  resolveDeclaredSlot,
  isMissingDeclaredSlot,
  onTogglePlugin,
  worldDataPreflight,
  worldDataPreflightStatus,
  worldDataPreflightError,
  onRetryWorldDataPreflight,
  flowData,
  selectedFlowSteps,
}: PluginSelectionCardProps) {
  const { t } = useTranslation();
  const totalRuntimes = selectedPackages.reduce(
    (sum, pkg) => sum + (pkg.runtimes?.length ?? 0),
    0,
  );

  return (
    <Card>
      <CollapsibleCardHeader
        expanded={expanded}
        onToggle={onToggleExpanded}
        contentId="plugin-selection-card-content"
        summary={t("session.pluginsSelectionSummary", {
          selectedCount: selectedPluginIds.length,
          pluginCount: packages.length,
          runtimeCount: totalRuntimes,
        })}
      >
        <Puzzle className="w-4 h-4" />
        {t("session.plugins", "Plugins & Runtimes")}
        <Badge variant="secondary" className="text-xs ml-1">
          {selectedPluginIds.length}/{packages.length}
        </Badge>
      </CollapsibleCardHeader>
      {expanded && (
        <CardContent
          id="plugin-selection-card-content"
          className="space-y-4 px-4 pb-4"
        >
          <div className="space-y-1.5">
            <PluginPackSelector
              pluginPacks={pluginPacks}
              activePluginPack={activePluginPack}
              onApplyPack={onApplyPack}
            />
            <PluginFilterBar
              pluginSearch={pluginSearch}
              onPluginSearchChange={onPluginSearchChange}
              availablePluginTags={availablePluginTags}
              activePluginTags={activePluginTags}
              onTogglePluginTag={onTogglePluginTag}
            />

            {pluginGroups.map((group) => (
              <div key={group.id} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3 pt-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                    {group.label}
                  </h4>
                  <span className="text-xs text-muted-foreground">
                    {group.packages.length}
                  </span>
                </div>
                {group.packages.map((pkg) => (
                  <PluginPackageRow
                    key={pkg.id}
                    pkg={pkg}
                    pluginPlan={pluginPlan}
                    activePluginPack={activePluginPack}
                    selectedPluginIdSet={selectedPluginIdSet}
                    corePluginIds={corePluginIds}
                    lockedPluginIds={lockedPluginIds}
                    bindingState={bindingState}
                    resolvedSlots={resolvedSlots}
                    resolveDeclaredSlot={resolveDeclaredSlot}
                    isMissingDeclaredSlot={isMissingDeclaredSlot}
                    onTogglePlugin={onTogglePlugin}
                  />
                ))}
              </div>
            ))}
          </div>

          <WorldDataPreflightPanel
            result={worldDataPreflight}
            status={worldDataPreflightStatus}
            error={worldDataPreflightError}
            onRetry={onRetryWorldDataPreflight}
          />

          {pluginPlanLoading && (
            <p className="text-xs text-muted-foreground">
              {t("session.pluginPlanLoading", "Resolving world plugin plan...")}
            </p>
          )}

          <ExecutionFlowPreview
            flowData={flowData}
            selectedFlowSteps={selectedFlowSteps}
            bindingState={bindingState}
          />
        </CardContent>
      )}
    </Card>
  );
}
