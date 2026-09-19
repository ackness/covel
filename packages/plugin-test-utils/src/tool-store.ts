import { createFunctionStoreView } from "@covel/runtime";
import type { DataStore } from "@covel/store";
import type { ToolModule } from "@covel/tools";

/** Supply invocation-scoped reads to direct tool unit tests, without committing. */
export function bindToolStore(
  module: ToolModule,
  store: DataStore,
): ToolModule {
  return {
    ...module,
    execute(params, context) {
      return module.execute(params, {
        ...context,
        store: createFunctionStoreView(
          store,
          context,
          structuredClone([...(context.pendingProposals ?? [])]),
        ),
      });
    },
  };
}
