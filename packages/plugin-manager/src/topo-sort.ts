/**
 * Topological sort for plugin dependency ordering.
 * Returns plugin IDs in load order (dependencies first).
 * Plugins with missing dependencies are appended at the end.
 */
export function topologicalSort(
  items: Array<{ id: string; dependencies: string[] }>,
): string[] {
  const graph = new Map<string, string[]>();
  const allIds = new Set<string>();

  for (const item of items) {
    allIds.add(item.id);
    graph.set(item.id, item.dependencies.filter((d) => allIds.has(d) || items.some((i) => i.id === d)));
  }

  const inDegree = new Map<string, number>();
  for (const id of allIds) inDegree.set(id, 0);

  for (const item of items) {
    for (const dep of item.dependencies) {
      if (allIds.has(dep)) {
        inDegree.set(item.id, (inDegree.get(item.id) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }
  queue.sort();

  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    // Find items that depend on current
    for (const item of items) {
      if (item.dependencies.includes(current) && allIds.has(item.id)) {
        const deg = (inDegree.get(item.id) ?? 1) - 1;
        inDegree.set(item.id, deg);
        if (deg === 0) {
          queue.push(item.id);
          queue.sort();
        }
      }
    }
  }

  // Append any remaining (circular deps or missing deps)
  for (const id of allIds) {
    if (!result.includes(id)) result.push(id);
  }

  return result;
}
