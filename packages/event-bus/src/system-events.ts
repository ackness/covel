// ── Trigger Events (drive runtime scheduling) ──────────────────────

export const TriggerEvents = {
  SESSION_PRE_GAME: "session.pre_game",
  SESSION_START: "session.start",
  TURN_START: "turn.start",
  TURN_INPUT: "turn.input",
  RUNTIME_MANUAL: "runtime.manual",
  APPROVAL_CALLBACK: "approval.callback",
} as const;

// ── Domain Events (business facts, emitted via kernel:emit_domain_event) ──

export const DomainEventExamples = {
  QUEST_COMPLETED: "quest.completed",
  COMBAT_ATTACK: "combat.attack",
  LOCATION_CHANGED: "location.changed",
  INVENTORY_ITEM_ACQUIRED: "inventory.item_acquired",
} as const;

// ── Runtime Bus Events (framework lifecycle & diagnostics) ──────────

export const RuntimeBusEvents = {
  RUNTIME_STARTED: "runtime.started",
  RUNTIME_COMPLETED: "runtime.completed",
  RUNTIME_FAILED: "runtime.failed",
  RUNTIME_SUSPENDED: "runtime.suspended",
  RUNTIME_RESUMED: "runtime.resumed",
  TOOL_CALLED: "tool.called",
  TOOL_DENIED: "tool.denied",
  PLUGIN_RELOADED: "plugin.reloaded",
  PLUGIN_LOADED: "plugin.loaded",
  PLUGIN_UNLOADED: "plugin.unloaded",
} as const;

export const SystemEvents = {
  ...TriggerEvents,
  ...RuntimeBusEvents,
} as const;
