import {
  canonicalizeLocale,
  isDefaultLocale,
  DEFAULT_FALLBACK_LOCALE,
  localeLookupCandidates,
} from "@covel/shared";
import type {
  ExtensionDeclaration,
  PluginManifest,
  PluginExtensionDefinition,
} from "@covel/shared";
import type { PluginAPI } from "./plugin-api.js";
import type { PluginEntryScope } from "./plugin-entry-scope.js";
import type { PluginExtensionHost } from "./plugin-extensions.js";

/** Declaration checks participate in the same atomic batch as other registrations. */
export function createExtensionRegistration(
  host: PluginExtensionHost | undefined,
  pluginId: string,
  declarations: readonly ExtensionDeclaration[],
  batch: PluginEntryScope,
  invalid: (message: string) => Error = (message) => new Error(message),
  staticSegments: NonNullable<
    NonNullable<PluginManifest["contributes"]>["prompt"]
  > = [],
  staticVariants: Readonly<Record<string, typeof staticSegments>> = {},
): {
  provideExtension: PluginAPI["provideExtension"];
  validate(): void;
} {
  if (staticSegments.length) {
    if (
      declarations.some(
        (d) => d.point === "prompt.segment@1" && d.id === "static-prompt",
      )
    )
      throw invalid("static-prompt is reserved for contributes.prompt");
    // Locale variants are resolved per-turn, so a plugin that ships any
    // PLUGIN.<locale>.md file can produce different content each turn.
    // When no variants exist the content never changes and should respect
    // the segment's declared volatility instead of breaking the cache every
    // turn unnecessarily.
    const hasLocaleVariants = Object.keys(staticVariants).length > 0;
    batch.stage(() => {
      if (!host) throw new Error("Plugin extension host is unavailable");
      batch.track(
        host.register(
          pluginId,
          { point: "prompt.segment@1", id: "static-prompt" },
          {
            handler: (_input, ctx) => {
              const locale = canonicalizeLocale(ctx.locale);
              const candidates = locale ? localeLookupCandidates(locale) : [];
              const match = candidates
                .map(
                  (candidate) =>
                    staticVariants[canonicalizeLocale(candidate) ?? candidate],
                )
                .find(Boolean);
              const segments =
                match ??
                (locale && !isDefaultLocale(locale)
                  ? staticVariants[DEFAULT_FALLBACK_LOCALE]
                  : undefined) ??
                staticSegments;
              return segments.map((segment) => ({
                ...segment,
                audience: "self",
                // Force turn-scoped volatility only when locale variants
                // exist — the selected variant can change per turn, so it
                // must not land in the stable cache zone.
                ...(hasLocaleVariants ? { volatility: "turn" as const } : {}),
              }));
            },
          },
        ),
      );
    });
  }
  const declared = new Map(declarations.map((d) => [`${d.point}/${d.id}`, d]));
  const provided = new Set<string>();
  return {
    provideExtension(point, id, definition) {
      batch.stage(() => {
        const key = `${point}/${id}`;
        const declaration = declared.get(key);
        if (!declaration)
          throw invalid(`Undeclared extension: ${pluginId}/${key}`);
        if (provided.has(key))
          throw invalid(`Duplicate extension: ${pluginId}/${key}`);
        if (!host) throw new Error("Plugin extension host is unavailable");
        try {
          batch.track(
            host.register(
              pluginId,
              declaration,
              retainedDefinition(batch, definition),
            ),
          );
        } catch {
          throw invalid(`Invalid extension implementation: ${pluginId}/${key}`);
        }
        provided.add(key);
      });
    },
    validate() {
      batch.stage(() => {
        for (const key of declared.keys()) {
          if (!provided.has(key))
            throw invalid(
              `Missing extension implementation: ${pluginId}/${key}`,
            );
        }
      });
    },
  };
}

function retainedDefinition<I, O>(
  batch: PluginEntryScope,
  definition: PluginExtensionDefinition<I, O>,
): PluginExtensionDefinition<I, O> {
  return {
    ...definition,
    handler: (input, context) =>
      batch.invoke(() => definition.handler(input, context)),
  };
}
