import { isBlockedTool } from "./_rules.js";

/**
 * PreToolUse — veto high-risk tool calls. `abort` here skips this one tool
 * (the framework feeds a synthetic tool-result back to the model) without
 * killing the turn.
 *
 * The gate reads `payload.toolCall.name` directly rather than relying on the
 * frontmatter `match`: the loader's `match` is a *shallow* equality test on the
 * top-level payload keys (`toolCall` / `pluginId` / `runtimeId`), but the tool
 * name is nested at `toolCall.name`, so a `match: { name: ... }` would never
 * fire. Keeping the deny-list in the handler is the working, testable gate.
 *
 * @param {import("@covel/runtime").HookContext} _ctx
 * @param {{ toolCall?: { name?: string } }} payload
 * @returns {Promise<{ action: "continue" } | { action: "abort", reason: string }>}
 */
export default async function guardTool(_ctx, payload) {
  const name = payload?.toolCall?.name;
  if (isBlockedTool(name)) {
    return {
      action: "abort",
      reason: `story-guard: tool "${name}" is blocked by content-safety policy`,
    };
  }
  return { action: "continue" };
}
