import { runWithHookScope } from "@covel/runtime";

/**
 * Run `fn` the way a session route or execution does, with these plugins
 * active. Hooks fire only inside a session hook scope; a test that drives the
 * pipeline directly names the plugins active for the call.
 */
export function inHookScope<T>(
  activePluginIds: Iterable<string>,
  fn: () => T,
): T {
  return runWithHookScope({ activePluginIds: new Set(activePluginIds) }, fn);
}
