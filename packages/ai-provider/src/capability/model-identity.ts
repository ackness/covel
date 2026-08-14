export type ModelMatchKind = "exact" | "namespace" | "model-name" | "prefix";

export interface ModelLookupCandidate {
  readonly id: string;
  readonly kind: Exclude<ModelMatchKind, "prefix">;
}

/**
 * Build lookup candidates for an opaque provider model ID.
 *
 * The first candidate is always the exact string sent to the provider. Later
 * candidates are capability-only aliases: an aggregator prefix matching the
 * configured provider is removed, then the final path segment is tried as a
 * bare model name. Callers must never replace the request model with one of
 * these derived values.
 */
export function modelLookupCandidateDetails(
  modelId: string,
  provider?: string,
): ModelLookupCandidate[] {
  const raw = modelId.trim().toLowerCase();
  if (!raw) return [];

  const candidates: ModelLookupCandidate[] = [];
  const add = (id: string, kind: ModelLookupCandidate["kind"]) => {
    const normalized = id.trim().toLowerCase();
    if (
      !normalized ||
      candidates.some((candidate) => candidate.id === normalized)
    )
      return;
    candidates.push({ id: normalized, kind });
  };

  add(raw, "exact");

  const segments = raw.split("/").filter(Boolean);
  const providerId = provider?.trim().toLowerCase();
  if (providerId && segments.length > 1 && segments[0] === providerId) {
    add(segments.slice(1).join("/"), "namespace");
  }
  if (segments.length > 1) {
    add(segments[segments.length - 1]!, "model-name");
  }

  return candidates;
}

export function modelLookupCandidates(
  modelId: string,
  provider?: string,
): string[] {
  return modelLookupCandidateDetails(modelId, provider).map(
    (candidate) => candidate.id,
  );
}

/** The namespace carried by the model ID after an optional transport prefix. */
export function modelNamespace(
  modelId: string,
  provider?: string,
): string | undefined {
  const segments = modelId.trim().toLowerCase().split("/").filter(Boolean);
  const providerId = provider?.trim().toLowerCase();
  if (segments.length > 2 && providerId && segments[0] === providerId) {
    return segments[1];
  }
  return segments.length > 1 ? segments[0] : undefined;
}
