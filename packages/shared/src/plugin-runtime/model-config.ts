export interface PluginLlmSlot {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly protocol?: string;
}

export interface PluginLlmConfig {
  /** Default model slot for this plugin. */
  readonly defaultSlot?: PluginLlmSlot;
  /** Named slots (e.g., plugin.fast, plugin.image). */
  readonly slots: Readonly<Record<string, PluginLlmSlot>>;
}
