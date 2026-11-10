import { aroundEach } from "vitest";
import {
  runWithHookScope,
  type HookScope,
} from "../../src/hooks/hook-scope.js";

/**
 * Run each test of the calling file inside an explicit session hook scope,
 * the way an execution entry point does. Hooks fire, and plugin settings
 * resolve, only inside a scope, so a file that drives the pipeline, an agent
 * loop or a commit below an entry point names the plugins active for it.
 * A test that opens its own `runWithHookScope` replaces this one.
 */
export function useHookScope(
  activePluginIds: Iterable<string> = [],
  scope: Omit<HookScope, "activePluginIds"> = {},
): void {
  aroundEach(async (runTest) => {
    await runWithHookScope(
      { ...scope, activePluginIds: new Set(activePluginIds) },
      runTest,
    );
  });
}
