import { Cpu, Lock, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { text } from "@/components/world/editor-helpers.js";
import { RuntimeStageBadges } from "../runtime-stage-badges.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import {
  effectiveSlotModel,
  formatSlotBindingLabel,
} from "@/hooks/use-slot-config.js";
import type { UseRuntimeBindingsResult } from "@/hooks/use-runtime-bindings.js";
import {
  recommendationReason,
  type PluginPack,
} from "@/lib/session-plugin-selection.js";
import { ProviderSlotSetting } from "./provider-slot-setting.js";
import type * as api from "@/services/api.js";
import { RuntimeCollectionFeatureBadges } from "../runtime-feature-badges.js";

export interface PluginPackageRowProps {
  worldPluginSettings?: import("@covel/shared").WorldPluginSettings;
  pkg: api.PluginSummary;
  pluginPlan: api.WorldPluginPlan | null;
  activePluginPack: PluginPack | null;
  selectedPluginIdSet: ReadonlySet<string>;
  corePluginIds: ReadonlySet<string>;
  lockedPluginIds: ReadonlySet<string>;
  bindingState: UseRuntimeBindingsResult;
  resolvedSlots: ResolvedSlot[];
  resolveDeclaredSlot: (slotId: string) => ResolvedSlot | null;
  isMissingDeclaredSlot: (slotId: string) => boolean;
  onTogglePlugin: (name: string) => void;
}

export function PluginPackageRow({
  worldPluginSettings,
  pkg,
  pluginPlan,
  activePluginPack,
  selectedPluginIdSet,
  corePluginIds,
  lockedPluginIds,
  bindingState,
  resolvedSlots,
  resolveDeclaredSlot,
  isMissingDeclaredSlot,
  onTogglePlugin,
}: PluginPackageRowProps) {
  const { t, i18n } = useTranslation();
  const displayName = text(pkg.displayName) || pkg.id;
  const description = text(pkg.description);
  const isSelected = selectedPluginIdSet.has(pkg.id);
  const isLocked = lockedPluginIds.has(pkg.id);
  const isCore = corePluginIds.has(pkg.id);
  const reason = recommendationReason(pkg, pluginPlan, activePluginPack, {
    locale: i18n.language,
    requiredByWorld: t(
      "session.recommendationReasons.requiredByWorld",
      "Required by world",
    ),
    packOptional: t(
      "session.recommendationReasons.packOptional",
      "Pack optional",
    ),
    recommendedByWorld: t(
      "session.recommendationReasons.recommendedByWorld",
      "Recommended by world",
    ),
  });
  const runtimes = pkg.runtimes ?? [];
  const tools = pkg.tools ?? [];
  const pluginBindings = bindingState.entries.filter(
    (entry) => entry.pluginId === pkg.id,
  );
  const textSlots = resolvedSlots.filter(
    (slot) => slot.tag === "text" && slot.isAvailable !== false,
  );
  const providerSlotSettings = pkg.userSettings.filter(
    (setting) => setting.type === "slot",
  );

  return (
    <div
      data-plugin-id={pkg.id}
      className={`prep-plugin-row border px-3 py-2.5 transition-colors ${
        isSelected
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-muted/15"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <button
          type="button"
          role="switch"
          aria-label={displayName}
          aria-checked={isSelected}
          disabled={isLocked}
          title={isLocked ? t("plugin.locked") : undefined}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors after:absolute after:-inset-2.5 after:content-[''] ${
            isSelected ? "bg-primary" : "bg-input"
          } ${isLocked ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          onClick={() => !isLocked && onTogglePlugin(pkg.id)}
        >
          <span
            className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-background shadow-sm transition ${
              isSelected ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>

        <span className="text-xs font-medium truncate flex-1 min-w-0">
          {displayName}
        </span>
        {isCore && (
          <span
            title={t("plugin.locked")}
            className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
          >
            <Lock className="w-3 h-3" />
            <span className="hidden sm:inline">{t("plugin.core", "core")}</span>
          </span>
        )}
        <RuntimeStageBadges runtimes={runtimes} />
        {runtimes.length > 0 && (
          <RuntimeCollectionFeatureBadges runtimes={runtimes} />
        )}
        {tools.length > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
            <Wrench className="w-2.5 h-2.5" />
            {tools.length}
          </span>
        )}
      </div>
      {description && (
        <p className="text-xs text-muted-foreground mt-1.5 ml-9 line-clamp-2">
          {description}
        </p>
      )}
      <div className="mt-1.5 ml-9 flex flex-wrap gap-1">
        {reason && (
          <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">
            {reason}
          </Badge>
        )}
        {(pkg.tags ?? []).slice(0, 4).map((tag) => (
          <Badge
            key={tag}
            variant="outline"
            className="text-xs px-1.5 py-0 h-4 text-muted-foreground"
          >
            {tag}
          </Badge>
        ))}
      </div>
      {isSelected &&
        providerSlotSettings.map((setting) => (
          <ProviderSlotSetting
            key={setting.key}
            pluginId={pkg.id}
            setting={setting}
            worldDefault={worldPluginSettings?.[pkg.id]?.[setting.key]}
            resolvedSlots={resolvedSlots}
            isMissingDeclaredSlot={isMissingDeclaredSlot}
          />
        ))}
      {isSelected && pluginBindings.length > 0 && (
        <div className="mt-2.5 ml-9 space-y-2">
          {pluginBindings.map((binding) => {
            const declared = binding.defaultSlot;
            const configuredDefault = resolveDeclaredSlot(declared);
            const effectiveName = binding.slotName || declared;
            const selectedSlot = binding.slotName
              ? textSlots.find((slot) => slot.slotId === binding.slotName)
              : configuredDefault?.tag === "text"
                ? configuredDefault
                : null;
            const missingOverride =
              binding.slotName &&
              !textSlots.some((slot) => slot.slotId === binding.slotName);
            return (
              <label
                key={binding.qualifiedId}
                className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"
              >
                <Cpu className="h-3 w-3 shrink-0" aria-hidden />
                <span className="break-all font-mono">
                  {binding.qualifiedId}
                </span>
                <Badge
                  variant={selectedSlot ? "outline" : "destructive"}
                  className="max-w-full break-all whitespace-normal text-xs"
                  role={selectedSlot ? undefined : "status"}
                >
                  {selectedSlot
                    ? formatSlotBindingLabel(selectedSlot)
                    : t("plugin.runtimeModelMissing", { slot: effectiveName })}
                </Badge>
                <select
                  aria-label={`${t("plugin.modelBinding")} · ${binding.qualifiedId}`}
                  value={binding.slotName}
                  onChange={(event) =>
                    bindingState.setBinding(
                      binding.qualifiedId,
                      event.target.value,
                    )
                  }
                  className="ml-auto w-full min-w-0 max-w-70 rounded border border-border bg-background px-2 py-1 text-xs"
                >
                  <option value="">
                    {effectiveSlotModel(configuredDefault)
                      ? t("plugin.runtimeDefaultSummaryWithModel", {
                          slot: declared,
                          model: effectiveSlotModel(configuredDefault),
                        })
                      : t("plugin.useRuntimeDefault", { slot: declared })}
                  </option>
                  {missingOverride && (
                    <option value={binding.slotName}>
                      {t("plugin.runtimeModelMissing", {
                        slot: binding.slotName,
                      })}
                    </option>
                  )}
                  {textSlots.map((slot) => (
                    <option key={slot.slotId} value={slot.slotId}>
                      {formatSlotBindingLabel(slot)}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
