import { useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SettingEntry } from "@covel/settings";
import { resolveI18nText } from "@covel/shared";
import { useSession } from "@/stores/session-store.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { useSetting } from "../use-settings.js";
import {
  InheritedSettingValues,
  SettingWidget,
  type InheritedSettingValue,
} from "../widgets/index.js";
import { SettingFieldList } from "../pane-layout.js";

export function PluginSettingsPane({
  entries,
}: {
  entries: readonly SettingEntry[];
}) {
  const { state } = useSession();
  const { resolvedSlots } = useSlotConfig(state.presets, state.llmConfig);
  const slotSettingKeys = new Set(
    state.plugins.flatMap((plugin) =>
      plugin.userSettings
        .filter((setting) => setting.type === "slot")
        .map((setting) => `plugin.${plugin.id}.${setting.key}`),
    ),
  );
  // The world being prepared or played sets defaults for its plugins. A key
  // the player has not set takes that value, not the manifest's, so the pane
  // shows it. A value the entry's schema refuses is not in force on the
  // server either.
  const { i18n } = useTranslation();
  const world = state.world;
  const inherited = useMemo(() => {
    const values = new Map<string, InheritedSettingValue>();
    const worldSettings = world?.metadata?.pluginSettings;
    if (!world || !worldSettings || typeof worldSettings !== "object") {
      return values;
    }
    const source = resolveI18nText(world.name, i18n.language) ?? world.id;
    for (const entry of entries) {
      if (!entry.pluginId) continue;
      const bucket = (worldSettings as Record<string, unknown>)[entry.pluginId];
      if (!bucket || typeof bucket !== "object") continue;
      const settingKey = entry.key.slice(`plugin.${entry.pluginId}.`.length);
      if (!Object.hasOwn(bucket, settingKey)) continue;
      const parsed = entry.schema.safeParse(
        (bucket as Record<string, unknown>)[settingKey],
      );
      if (parsed.success) {
        values.set(entry.key, { value: parsed.data, source });
      }
    }
    return values;
  }, [entries, world, i18n.language]);
  return (
    <InheritedSettingValues value={inherited}>
      <SettingFieldList>
        {entries.map((entry) =>
          slotSettingKeys.has(entry.key) ? (
            <PluginSlotSetting
              key={entry.key}
              entry={entry}
              slotIds={resolvedSlots.map((slot) => slot.slotId)}
            />
          ) : (
            <SettingWidget key={entry.key} entry={entry} />
          ),
        )}
      </SettingFieldList>
    </InheritedSettingValues>
  );
}

function PluginSlotSetting({
  entry,
  slotIds,
}: {
  entry: SettingEntry;
  slotIds: string[];
}) {
  const [value] = useSetting<string>(entry.key);
  const inherited = useContext(InheritedSettingValues).get(entry.key)?.value;
  const options = [
    ...new Set([
      ...slotIds,
      ...(typeof entry.default === "string" ? [entry.default] : []),
      ...(typeof inherited === "string" && inherited ? [inherited] : []),
      ...(value ? [value] : []),
    ]),
  ]
    .sort()
    .map((id) => ({ value: id, label: id }));
  return <SettingWidget entry={{ ...entry, options }} />;
}
