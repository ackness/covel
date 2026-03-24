export interface ContextNode {
  id: string;
  source: string;
  priority: number;
  tokenCost: number;
  pinned: boolean;
  content: string;
  provenance: Record<string, unknown>;
}

export interface ContextGraph {
  nodes: ContextNode[];
}

export function createContextGraph(input: { nodes: ContextNode[] }): ContextGraph {
  const deduped = new Map<string, ContextNode>();

  for (const node of input.nodes) {
    const existing = deduped.get(node.id);
    if (!existing || node.priority > existing.priority) {
      deduped.set(node.id, node);
    }
  }

  return {
    nodes: Array.from(deduped.values()).sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }

      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }

      return left.id.localeCompare(right.id);
    })
  };
}
