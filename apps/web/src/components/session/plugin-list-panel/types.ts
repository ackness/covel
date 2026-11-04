import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import type {
  PluginSummary,
  PluginLoadError,
  SessionPlugin,
  SetupRuntimeState,
} from "@/services/api.js";

export interface PluginListPanelProps {
  plugins: PluginSummary[];
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
  /** Current `runtimeModelOverrides` map from SessionRecord (read-only). */
  runtimeModelOverrides?: Record<string, string>;
  /** Current `setupRuntimes` lifecycle map from SessionRecord. */
  setupRuntimes?: Record<string, SetupRuntimeState>;
  /** Show step lists, stage badges and tools. */
  developerMode?: boolean;
  /** Opens the settings dialog on the model pane. */
  onOpenModelSettings?: () => void;
}

export interface PluginItemProps {
  advanced?: boolean;
  pkg: PluginSummary;
  sessionPlugin?: SessionPlugin;
  executing?: boolean;
  onToggle?: (pluginId: string, enable: boolean) => void;
  resolvedSlots?: ResolvedSlot[];
  sessionId?: string;
  runtimeModelOverrides?: Record<string, string>;
  setupRuntimes?: Record<string, SetupRuntimeState>;
  onOpenModelSettings?: () => void;
}

export interface PluginErrorItemProps {
  error: PluginLoadError;
}

export interface SessionPluginItemProps {
  advanced?: boolean;
  plugin: SessionPlugin;
  executing?: boolean;
  onToggle?: (pluginId: string, enable: boolean) => void;
  resolvedSlots?: ResolvedSlot[];
  sessionId?: string;
  runtimeModelOverrides?: Record<string, string>;
  setupRuntimes?: Record<string, SetupRuntimeState>;
  onOpenModelSettings?: () => void;
}
