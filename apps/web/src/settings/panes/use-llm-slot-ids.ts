import { useSession } from "@/stores/session-store.js";
import { getSettings } from "../store.js";
import { useSettingsRevision } from "../use-settings-revision.js";
import {
  createVisibleSlotIds,
  discoverRuntimeSlotIds,
} from "./llm-slots-model.js";

/** Keep assignment and generation panes on the same live role catalogue. */
export function useLlmSlotIds() {
  const { state } = useSession();
  const plugins = state.plugins ?? [];
  const store = getSettings();
  const providerSlotKeys = plugins.flatMap((plugin) =>
    plugin.userSettings
      .filter((setting) => setting.type === "slot")
      .map((setting) => `plugin.${plugin.id}.${setting.key}`),
  );
  useSettingsRevision([
    "llm.slotConfig",
    "llm.paramOverrides",
    "llm.capabilityOverrides",
    ...providerSlotKeys,
  ]);
  const discoveredSlotIds = [
    ...new Set([
      ...discoverRuntimeSlotIds(plugins),
      ...providerSlotKeys.flatMap((key) => {
        const value = store.get<unknown>(key);
        return typeof value === "string" && value ? [value] : [];
      }),
    ]),
  ];
  const configuredSlots = Object.keys(state.llmConfig?.slots ?? {});
  const slots = createVisibleSlotIds({
    isConfigured: state.llmConfig?.configured ?? false,
    configuredSlots,
    discoveredSlotIds,
    savedSlotIds: [
      "llm.slotConfig",
      "llm.paramOverrides",
      "llm.capabilityOverrides",
    ].flatMap((key) =>
      Object.keys(store.get<Record<string, unknown>>(key) ?? {}),
    ),
  });
  return { slots, configuredSlots, discoveredSlotIds };
}
