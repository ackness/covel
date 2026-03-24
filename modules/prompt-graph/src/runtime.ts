import type { ContextGraph } from "../../context-graph/src/index.js";

export interface PromptNode {
  id: string;
  content: string;
  tokenCost: number;
  pinned: boolean;
  source: string;
}

export interface PromptGraph {
  nodes: PromptNode[];
  totalTokenCost: number;
}

export function compilePromptGraph(input: {
  contextGraph: ContextGraph;
  maxTokens: number;
}): PromptGraph {
  const selected: PromptNode[] = [];
  let totalTokenCost = 0;

  for (const node of input.contextGraph.nodes) {
    if (!node.pinned && totalTokenCost + node.tokenCost > input.maxTokens) {
      continue;
    }

    selected.push({
      id: node.id,
      content: node.content,
      tokenCost: node.tokenCost,
      pinned: node.pinned,
      source: node.source
    });
    totalTokenCost += node.tokenCost;
  }

  return {
    nodes: selected,
    totalTokenCost
  };
}
