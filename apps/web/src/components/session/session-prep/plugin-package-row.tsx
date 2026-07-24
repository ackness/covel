import { useEffect, useState } from "react";
import { Cpu, KeyRound, Lock, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge.js";
import { text } from "@/components/world/editor-helpers.js";
import { stageLabel } from "@/lib/stage-label.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import { formatSlotLabel } from "@/hooks/use-slot-config.js";
import type { UseRuntimeBindingsResult } from "@/hooks/use-runtime-bindings.js";
import {
  recommendationReason,
  type PluginPack,
} from "@/lib/session-plugin-selection.js";
import { getSettings } from "@/settings/store.js";
import { resolveProviderSlot } from "./model-slot-helpers.js";
import type * as api from "@/services/api.js";

export interface PluginPackageRowProps {
  pkg: api.PackageSummary;
  world: api.WorldRecord;
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
  pkg,
  world,
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
  const displayName = text(pkg.displayName) || pkg.name;
  const description = text(pkg.description);
  const isSelected = selectedPluginIdSet.has(pkg.name);
  const isLocked = lockedPluginIds.has(pkg.name);
  const isCore = corePluginIds.has(pkg.name);
  const reason = recommendationReason(pkg, world, activePluginPack, {
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
    (entry) => entry.pluginId === pkg.name,
  );
  const primaryBinding = pluginBindings[0];
  const hasAgentRuntime = pluginBindings.length > 0;
  const providerSlotSetting = pkg.userSettings?.find(
    (spec) => spec.key === "modelPresetId",
  );
  const manifestDefaultSlot =
    typeof providerSlotSetting?.default === "string"
      ? providerSlotSetting.default
      : undefined;
  const providerSlotKey = `plugin.${pkg.name}.modelPresetId`;
  const [providerSlotOverride, setProviderSlotOverride] = useState<
    string | undefined
  >(() => {
    const store = getSettings();
    return store.has(providerSlotKey)
      ? store.get<string>(providerSlotKey)
      : undefined;
  });
  // Reflect out-of-band edits to this setting (e.g. from Settings > Plugins)
  // while the prep screen is open. The initializer above only reads once, so
  // without this an external change would leave the picker stale.
  useEffect(() => {
    const store = getSettings();
    const read = () =>
      store.has(providerSlotKey)
        ? store.get<string>(providerSlotKey)
        : undefined;
    setProviderSlotOverride(read());
    return store.subscribe<string>(providerSlotKey, () => {
      setProviderSlotOverride(read());
    });
  }, [providerSlotKey]);
  const {
    effectiveSlot: effectiveProviderSlot,
    missing: providerSlotMissing,
    isOverridden: providerSlotOverridden,
  } = resolveProviderSlot({
    manifestDefault: manifestDefaultSlot,
    override: providerSlotOverride,
    isMissing: isMissingDeclaredSlot,
  });
  // Player picks a configured slot inline (no trip to Settings > Plugins). The
  // override lands in the SettingsStore under `plugin.<id>.modelPresetId`, which
  // the X-Plugin-User-Settings header reads live — so the function runtime
  // resolves it server-side without any extra plumbing.
  const handleProviderSlotChange = (value: string): void => {
    const store = getSettings();
    if (value === "") {
      void store.clear(providerSlotKey);
      setProviderSlotOverride(undefined);
    } else {
      void store.set(providerSlotKey, value);
      setProviderSlotOverride(value);
    }
  };
  const hasMissingRuntimeSlot = pluginBindings.some((binding) =>
    isMissingDeclaredSlot(binding.defaultSlot),
  );

  return (
    <div
      className={`border px-3 py-2.5 transition-colors ${
        isSelected
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-muted/20 opacity-60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <button
          type="button"
          role="switch"
          aria-checked={isSelected}
          disabled={isLocked}
          title={isLocked ? t("plugin.locked") : undefined}
          className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border-2 border-transparent transition-colors ${
            isSelected ? "bg-primary" : "bg-input"
          } ${isLocked ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          onClick={() => !isLocked && onTogglePlugin(pkg.name)}
        >
          <span
            className={`pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow-sm transition ${
              isSelected ? "translate-x-3" : "translate-x-0"
            }`}
          />
        </button>

        <span className="text-xs font-medium truncate flex-1 min-w-0">
          {displayName}
        </span>
        {isCore && (
          <span
            title={t("plugin.locked")}
            className="inline-flex items-center gap-0.5 text-[9px] text-muted-foreground/70 shrink-0"
          >
            <Lock className="w-3 h-3" />
            <span className="hidden sm:inline">{t("plugin.core", "core")}</span>
          </span>
        )}
        {runtimes[0] && stageLabel(runtimes[0].stage, t) && (
          <Badge variant="outline" className="text-[9px] shrink-0">
            {stageLabel(runtimes[0].stage, t)}
          </Badge>
        )}
        {runtimes[0]?.kind && (
          <Badge variant="secondary" className="text-[9px] shrink-0">
            {runtimes[0].kind === "agent" ? "LLM" : "Fn"}
          </Badge>
        )}
        {tools.length > 0 && (
          <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground shrink-0">
            <Wrench className="w-2.5 h-2.5" />
            {tools.length}
          </span>
        )}
        {hasAgentRuntime &&
          isSelected &&
          primaryBinding &&
          pluginBindings.length === 1 &&
          !hasMissingRuntimeSlot &&
          resolvedSlots.length > 1 && (
            <select
              value={primaryBinding.slotName}
              onChange={(event) =>
                bindingState.setBinding(
                  primaryBinding.qualifiedId,
                  event.target.value,
                )
              }
              className="min-w-[100px] flex-shrink text-[11px] bg-background border border-border rounded px-2 py-1 max-w-[240px]"
              aria-label={t(
                "plugin.modelBindingAria",
                "Which model slot this plugin's runtime will use. Leave at default unless you have a reason to override.",
              )}
              title={t(
                "plugin.modelBindingAria",
                "Which model slot this plugin's runtime will use. Leave at default unless you have a reason to override.",
              )}
            >
              <option value="">
                {(() => {
                  const declared = primaryBinding.defaultSlot;
                  const defaultSlot = resolveDeclaredSlot(declared);
                  const label = formatSlotLabel(defaultSlot);
                  if (label) {
                    return t("plugin.useRuntimeDefaultWith", {
                      slot: declared,
                      value: label,
                      defaultValue: `Runtime default: ${declared} (${label})`,
                    });
                  }
                  return t("plugin.useRuntimeDefault", {
                    slot: declared,
                    defaultValue: `Runtime default: ${declared}`,
                  });
                })()}
              </option>
              {resolvedSlots.map((slot) => (
                <option key={slot.slotId} value={slot.slotId}>
                  {slot.slotId}
                  {slot.serverModel ? ` · ${slot.serverModel}` : ""}
                </option>
              ))}
            </select>
          )}
      </div>
      {description && (
        <p className="text-[11px] text-muted-foreground mt-1.5 ml-9 line-clamp-2">
          {description}
        </p>
      )}
      <div className="mt-1.5 ml-9 flex flex-wrap gap-1">
        {reason && (
          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4">
            {reason}
          </Badge>
        )}
        {(pkg.tags ?? []).slice(0, 4).map((tag) => (
          <Badge
            key={tag}
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-4 text-muted-foreground"
          >
            {tag}
          </Badge>
        ))}
      </div>
      {isSelected && providerSlotSetting && (
        <div className="mt-2.5 ml-9 flex flex-wrap items-center gap-2.5 text-[11px] text-muted-foreground min-w-0">
          <KeyRound className="w-3 h-3 shrink-0" />
          <span className="font-medium shrink-0">
            {t("plugin.providerSlot", "provider slot")}
          </span>
          <Badge
            variant={providerSlotMissing ? "destructive" : "outline"}
            className="text-[10px] px-1.5 py-0.5 h-5 shrink-0"
            title={
              providerSlotMissing
                ? t("plugin.providerSlotMissingTitle", {
                    slot: effectiveProviderSlot,
                    plugin: pkg.name,
                    defaultValue:
                      "Add [covel.{{slot}}] to llm.toml, or pick a configured slot here.",
                  })
                : undefined
            }
          >
            {providerSlotMissing
              ? t("plugin.slotMissingShort", {
                  slot: effectiveProviderSlot,
                  defaultValue: "missing [covel.{{slot}}]",
                })
              : `[covel.${effectiveProviderSlot}]`}
          </Badge>
          {providerSlotOverridden && (
            <Badge
              variant="secondary"
              className="text-[9px] px-1.5 py-0 h-4 shrink-0"
            >
              {t("plugin.providerSlotOverridden", "overridden")}
            </Badge>
          )}
          {/* Inline override: pick any configured slot without leaving prep.
              "" = fall back to the manifest default. */}
          {resolvedSlots.length > 0 && (
            <select
              value={providerSlotOverride ?? ""}
              onChange={(event) => handleProviderSlotChange(event.target.value)}
              className="ml-auto min-w-[120px] flex-shrink text-[11px] bg-background border border-border rounded px-2 py-1 max-w-[280px]"
              aria-label={t(
                "plugin.providerSlotOverrideAria",
                "Override which configured slot this plugin's provider uses. Leave at default unless you have a reason to change it.",
              )}
            >
              <option value="">
                {manifestDefaultSlot
                  ? t("plugin.providerSlotDefaultOption", {
                      slot: manifestDefaultSlot,
                      defaultValue: "default · [covel.{{slot}}]",
                    })
                  : t("plugin.providerSlotNoDefault", "default")}
              </option>
              {resolvedSlots.map((slot) => (
                <option key={slot.slotId} value={slot.slotId}>
                  {slot.slotId}
                  {slot.serverModel ? ` · ${slot.serverModel}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {isSelected &&
        pluginBindings.length > 0 &&
        (pluginBindings.length > 1 || hasMissingRuntimeSlot) && (
          <div className="mt-2.5 ml-9 space-y-1.5">
            {pluginBindings.map((binding) => {
              const declaredSlot = binding.defaultSlot;
              const configuredDefault = resolveDeclaredSlot(declaredSlot);
              const selectedSlot = binding.slotName
                ? resolvedSlots.find((slot) => slot.slotId === binding.slotName)
                : configuredDefault;
              const missingDefault = isMissingDeclaredSlot(declaredSlot);
              const showPicker =
                pluginBindings.length > 1 ||
                missingDefault ||
                resolvedSlots.length > 1;
              return (
                <div
                  key={binding.qualifiedId}
                  className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground min-w-0"
                >
                  <Cpu className="w-3 h-3 shrink-0" />
                  <span
                    className="font-mono truncate min-w-0 max-w-[240px]"
                    title={binding.qualifiedId}
                  >
                    {binding.qualifiedId}
                  </span>
                  <Badge
                    variant={missingDefault ? "destructive" : "outline"}
                    className="text-[10px] px-1.5 py-0.5 h-5 shrink-0"
                    title={
                      missingDefault
                        ? t("plugin.slotMissingTitle", {
                            slot: declaredSlot,
                            defaultValue: "Add [covel.{{slot}}] to llm.toml",
                          })
                        : undefined
                    }
                  >
                    {missingDefault
                      ? t("plugin.slotMissingShort", {
                          slot: declaredSlot,
                          defaultValue: "missing [covel.{{slot}}]",
                        })
                      : `default: ${declaredSlot}`}
                  </Badge>
                  {missingDefault && (
                    <code className="text-[10px] text-muted-foreground/80 bg-muted px-1.5 py-0.5 rounded shrink-0">
                      [covel.{declaredSlot}]
                    </code>
                  )}
                  {showPicker ? (
                    <select
                      value={binding.slotName}
                      onChange={(event) =>
                        bindingState.setBinding(
                          binding.qualifiedId,
                          event.target.value,
                        )
                      }
                      className="ml-auto min-w-[120px] flex-shrink text-[11px] bg-background border border-border rounded px-2 py-1 max-w-[280px]"
                      aria-label={t(
                        "plugin.modelBindingAria",
                        "Which model slot this plugin's runtime will use. Leave at default unless you have a reason to override.",
                      )}
                    >
                      <option value="">
                        {configuredDefault
                          ? configuredDefault.serverModel
                            ? t("plugin.runtimeDefaultSummaryWithModel", {
                                slot: declaredSlot,
                                model: configuredDefault.serverModel,
                                defaultValue:
                                  "runtime default · {{slot}} · {{model}}",
                              })
                            : t("plugin.runtimeDefaultSummary", {
                                slot: declaredSlot,
                                defaultValue: "runtime default · {{slot}}",
                              })
                          : t("plugin.runtimeDefaultMissing", {
                              slot: declaredSlot,
                              defaultValue:
                                "runtime default · {{slot}} (missing)",
                            })}
                      </option>
                      {resolvedSlots.map((slot) => (
                        <option key={slot.slotId} value={slot.slotId}>
                          {slot.slotId}
                          {slot.serverModel ? ` · ${slot.serverModel}` : ""}
                        </option>
                      ))}
                    </select>
                  ) : selectedSlot ? (
                    <span
                      className="ml-auto truncate text-[11px]"
                      title={
                        formatSlotLabel(selectedSlot) ?? selectedSlot.slotId
                      }
                    >
                      {formatSlotLabel(selectedSlot) ?? selectedSlot.slotId}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
