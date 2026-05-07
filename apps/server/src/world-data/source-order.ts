import type {
  MergedWorldDataSource,
  OrderedWorldDataSource,
  WorldDataDiagnostic,
} from "./types.js";

function afterList(
  after: string | readonly string[] | undefined,
): readonly string[] {
  if (after === undefined) return [];
  return typeof after === "string" ? [after] : after;
}

export function orderSources(sources: readonly MergedWorldDataSource[]): {
  sources: readonly OrderedWorldDataSource[];
  diagnostics: readonly WorldDataDiagnostic[];
} {
  const diagnostics: WorldDataDiagnostic[] = [];
  const byId = new Map(sources.map((source) => [source.id, source]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const source of sources) {
    indegree.set(source.id, 0);
    dependents.set(source.id, []);
  }

  for (const source of sources) {
    for (const dep of afterList(source.descriptor.after)) {
      if (!byId.has(dep)) {
        diagnostics.push({
          level: "error",
          sourceId: source.id,
          message: `source "${source.id}" declares after: "${dep}", but that source does not exist`,
        });
        continue;
      }
      indegree.set(source.id, (indegree.get(source.id) ?? 0) + 1);
      dependents.get(dep)!.push(source.id);
    }
  }

  const byDeclarationOrder = [...sources].sort((a, b) => a.order - b.order);
  const ready = byDeclarationOrder.filter(
    (source) => indegree.get(source.id) === 0,
  );
  const ordered: MergedWorldDataSource[] = [];

  while (ready.length > 0) {
    ready.sort((a, b) => a.order - b.order);
    const current = ready.shift()!;
    ordered.push(current);
    for (const dependentId of dependents.get(current.id) ?? []) {
      const nextIndegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, nextIndegree);
      if (nextIndegree === 0) {
        const dependent = byId.get(dependentId);
        if (dependent) ready.push(dependent);
      }
    }
  }

  if (ordered.length !== sources.length) {
    const orderedIds = new Set(ordered.map((source) => source.id));
    for (const source of byDeclarationOrder) {
      if (!orderedIds.has(source.id)) {
        diagnostics.push({
          level: "error",
          sourceId: source.id,
          message: `source "${source.id}" is part of a circular after dependency`,
        });
      }
    }
  }

  return {
    sources: ordered.map((source, resolvedOrder) => ({
      ...source,
      resolvedOrder,
    })),
    diagnostics,
  };
}
