/**
 * Several plugins of one session's set keep world dimensions. A session has
 * one: the player chooses which, so the server names the candidates instead
 * of picking one. The global error handler answers it with `409
 * dimension_provider_conflict`; this module imports nothing, so that handler
 * does not load the world-data importer.
 */
export class DimensionProviderConflictError extends Error {
  readonly code = "dimension_provider_conflict";
  constructor(
    readonly candidates: readonly string[],
    message = `Several plugins keep world dimensions (${candidates.join(", ")}). Keep one of them and turn the others off.`,
  ) {
    super(message);
    this.name = "DimensionProviderConflictError";
  }
}

/**
 * Other plugins would take the dimensions a session keeps under the provider
 * it bound. They stay with that provider, which may only be unavailable for
 * now; it is named first among the candidates.
 */
export function boundDimensionProviderConflict(
  bound: string,
  others: readonly string[],
): DimensionProviderConflictError {
  const names = others.map((id) => `"${id}"`).join(", ");
  const one = others.length === 1;
  return new DimensionProviderConflictError(
    [bound, ...others],
    `This session's dimensions belong to "${bound}". ${names} ${one ? "also keeps" : "also keep"} world dimensions and cannot take them over; keep ${one ? "it" : "them"} off.`,
  );
}
