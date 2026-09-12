import type { SettingEntry } from "@covel/settings";
import { useSession } from "@/stores/session-store.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { useSetting } from "../use-settings.js";
import { SettingWidget } from "../widgets/index.js";

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
  return (
    <div className="space-y-4">
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
    </div>
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
  const options = [
    ...new Set([
      ...slotIds,
      ...(typeof entry.default === "string" ? [entry.default] : []),
      ...(value ? [value] : []),
    ]),
  ]
    .sort()
    .map((id) => ({ value: id, label: id }));
  return <SettingWidget entry={{ ...entry, options }} />;
}
