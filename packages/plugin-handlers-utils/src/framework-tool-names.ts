/** Reserved even when a host does not install an optional or virtual builtin. */
export const FRAMEWORK_TOOL_NAMES = [
  "render-ui",
  "create-form",
  "create-choices",
  "create-notification",
  "suspend",
  "runtime-done",
  "search-tools",
  "emit-event",
  "sync-characters",
  "list-characters",
  "get-character",
  "memory-search",
  "world-dimension-get",
  "world-dimension-list",
  "delegate",
] as const;

/** Reviewed framework capabilities; generated datasets and imports have their own scopes. */
export const FRAMEWORK_TOOL_CAPABILITIES: Readonly<
  Partial<
    Record<
      (typeof FRAMEWORK_TOOL_NAMES)[number],
      "read" | "ui" | "control" | "character-write"
    >
  >
> = {
  "render-ui": "ui",
  "create-form": "ui",
  "create-choices": "ui",
  "create-notification": "ui",
  suspend: "control",
  "runtime-done": "control",
  "search-tools": "control",
  "emit-event": "control",
  "sync-characters": "character-write",
  "list-characters": "read",
  "get-character": "read",
  "memory-search": "read",
  "world-dimension-get": "read",
  "world-dimension-list": "read",
  delegate: "control",
};

export function isDeclarativeFrameworkTool(name: string): boolean {
  return Object.hasOwn(FRAMEWORK_TOOL_CAPABILITIES, name);
}
