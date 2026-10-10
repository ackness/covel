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

/**
 * Thrown by a host tool to refuse a call that the model cannot correct: what
 * the call names does not exist in this session. The model reads the call as
 * failed and it is no business work, but it is not a failure of the runtime,
 * which may still finish with its output.
 */
export class ToolRefusal extends Error {
  override readonly name = "ToolRefusal";
}
