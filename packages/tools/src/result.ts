/** The public SDK owns the result protocol used by authors and the host. */
export {
  getToolContent,
  getPendingProposals,
  getEmittedEvents,
  withPendingProposals,
  withEmittedEvents,
} from "@covel/plugin-handlers-utils";
export type {
  PluginToolResult as ToolExecutionEnvelope,
  EmittedEvent,
} from "@covel/plugin-handlers-utils";
