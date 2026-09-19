import type { SessionDispatch } from "./types.js";

interface PendingRead {
  readonly resource: readonly string[];
  changed: boolean;
}

// The key is the provider's stable, original dispatch function. Temporary
// wrappers such as dispatchCurrent must never be used as ownership keys.
const providerReads = new WeakMap<SessionDispatch, Map<string, PendingRead>>();

/**
 * A committed event invalidates only reads that overlap its resource. A whole
 * plugin snapshot overlaps each of its namespaces; unrelated plugins/worlds do
 * not. Only in-flight reads are retained, and completion releases their entries.
 */
export function invalidateSessionResource(
  owner: SessionDispatch,
  resource: readonly string[],
): void {
  invalidateOverlappingReads(owner, resource);
}

function invalidateOverlappingReads(
  owner: SessionDispatch,
  resource: readonly string[],
  publishing?: PendingRead,
): void {
  const reads = providerReads.get(owner);
  if (!reads) return;
  for (const pending of reads.values()) {
    if (pending === publishing) continue;
    const shared = Math.min(resource.length, pending.resource.length);
    if (
      resource
        .slice(0, shared)
        .every((part, index) => part === pending.resource[index])
    ) {
      pending.changed = true;
    }
  }
}

/**
 * Read and publish for one provider resource. Replaced requests and obsolete
 * visits stop. A still-current read observes a committed mutation by re-reading
 * that resource, preserving fields absent from the live event. Network errors
 * propagate without retry. apply is synchronous to close the publication gap.
 */
export async function refreshSessionResource<T>(
  owner: SessionDispatch,
  resource: readonly string[],
  options: {
    isCurrent: () => boolean;
    read: () => Promise<T>;
    apply: (value: T) => void;
  },
): Promise<void> {
  if (!options.isCurrent()) return;
  const reads = providerReads.get(owner) ?? new Map<string, PendingRead>();
  providerReads.set(owner, reads);
  const key = JSON.stringify(resource);
  const pending: PendingRead = { resource: [...resource], changed: false };
  reads.set(key, pending);
  const isCurrent = () => reads.get(key) === pending && options.isCurrent();
  try {
    while (isCurrent()) {
      pending.changed = false;
      const value = await options.read();
      if (!isCurrent()) return;
      if (pending.changed) continue;
      // An overlapping snapshot may have started before this observation.
      // Refresh it without discarding fields outside this read's narrower scope.
      invalidateOverlappingReads(owner, resource, pending);
      options.apply(value);
      return;
    }
  } catch (error) {
    if (isCurrent()) throw error;
  } finally {
    if (reads.get(key) === pending) reads.delete(key);
    if (reads.size === 0 && providerReads.get(owner) === reads)
      providerReads.delete(owner);
  }
}
