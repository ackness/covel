import type {
  RegisteredContextProvider,
  ContextProviderInput,
} from "@covel/plugin-runtime";

/** A resolved context fragment from a provider, ready for prompt injection. */
export interface ContextFragment {
  id: string;
  pluginId: string;
  title: string;
  content: string;
  priority: number;
}

/**
 * Call all registered context providers and collect their fragments.
 *
 * Fragments are sorted by priority (highest first) so they can be
 * prepended to the runtime's instructions in the correct order.
 */
export async function gatherContextFragments(
  providers: ReadonlyMap<string, RegisteredContextProvider>,
  input: ContextProviderInput
): Promise<ContextFragment[]> {
  const fragments: ContextFragment[] = [];

  const tasks = Array.from(providers.values()).map(async (provider) => {
    try {
      const result = await provider.handler(input);
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (typeof r.content === "string" && r.content.length > 0) {
          const rawPriority = typeof r.priority === "number" ? r.priority : 0;
          fragments.push({
            id: typeof r.id === "string" ? r.id : provider.id,
            pluginId: provider.pluginId,
            title: typeof r.title === "string" ? r.title : provider.id,
            content: r.content,
            priority: Number.isFinite(rawPriority) ? rawPriority : 0,
          });
        }
      }
    } catch (err) {
      console.warn(
        `[context-provider-bridge] Provider ${provider.pluginId}:${provider.id} failed:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  });

  await Promise.all(tasks);

  // Sort by priority descending (highest priority = first in prompt)
  fragments.sort((a, b) => b.priority - a.priority);

  return fragments;
}
