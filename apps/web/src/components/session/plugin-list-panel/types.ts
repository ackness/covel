import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import type {
  PluginSummary,
  PluginLoadError,
  SessionPlugin,
  SetupRuntimeState,
} from "@/services/api.js";

export type RuntimeModelOverrideChange = (
  runtimeKey: string,
  slot: string,
) => Promise<void>;

export interface PluginListPanelProps {
  packages: PluginSummary[];
  loadErrors?: PluginLoadError[];
  /** Session-scoped plugin info with live active state. */
  sessionPlugins?: SessionPlugin[];
  /** Whether a turn is currently executing (disables toggles mid-turn). */
  executing?: boolean;
  /** Called when the user flips the enable/disable switch. */
  onTogglePlugin?: (pluginId: string, enable: boolean) => void;
  /** Available model slots for runtime binding. */
  resolvedSlots?: ResolvedSlot[];
  /** Current session ID (for persisting runtime bindings). */
  sessionId?: string;
  /** Current `runtimeModelOverrides` map from SessionRecord. */
  runtimeModelOverrides?: Record<string, string>;
  onRuntimeModelOverrideChange?: RuntimeModelOverrideChange;
  /** Current `setupRuntimes` lifecycle map from SessionRecord. */
  setupRuntimes?: Record<string, SetupRuntimeState>;
}

export interface PluginItemProps {
  pkg: PluginSummary;
  sessionPlugin?: SessionPlugin;
  executing?: boolean;
  onToggle?: (pluginId: string, enable: boolean) => void;
  resolvedSlots?: ResolvedSlot[];
  sessionId?: string;
  runtimeModelOverrides?: Record<string, string>;
  onRuntimeModelOverrideChange?: RuntimeModelOverrideChange;
  setupRuntimes?: Record<string, SetupRuntimeState>;
}

export interface PluginErrorItemProps {
  error: PluginLoadError;
}

export interface SessionPluginItemProps {
  plugin: SessionPlugin;
  executing?: boolean;
  onToggle?: (pluginId: string, enable: boolean) => void;
  resolvedSlots?: ResolvedSlot[];
  sessionId?: string;
  runtimeModelOverrides?: Record<string, string>;
  onRuntimeModelOverrideChange?: RuntimeModelOverrideChange;
  setupRuntimes?: Record<string, SetupRuntimeState>;
}

export const TRIGGER_LABELS: Record<string, { key: string; fallback: string }> =
  {
    auto: { key: "plugin.triggerAuto", fallback: "Every turn" },
    always: { key: "plugin.triggerAlways", fallback: "Always" },
    scheduled: { key: "plugin.triggerScheduled", fallback: "Scheduled" },
    interval: { key: "plugin.triggerInterval", fallback: "Interval" },
    manual: { key: "plugin.triggerManual", fallback: "Manual" },
    event: { key: "plugin.triggerEvent", fallback: "Event" },
  };

export const TRIGGER_TYPE_I18N: Record<
  string,
  { key: string; fallback: string }
> = {
  auto: { key: "plugin.triggerAuto", fallback: "Every turn" },
  scheduled: { key: "plugin.triggerScheduled", fallback: "Scheduled" },
  manual: { key: "plugin.triggerManual", fallback: "Manual" },
  event: { key: "plugin.triggerEvent", fallback: "Event" },
};

export const RUNTIME_TYPE_ICONS: Record<string, string> = {
  agent: "LLM",
  function: "Fn",
};
