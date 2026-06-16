/**
 * graph-types — shared shapes for the GraphCanvas force-graph wrapper.
 */

export interface ForceNode {
  id: string;
  name: string;
  type: "individual" | "group" | "faction";
  summary: string;
  labels: string[];
  color: string;
  radius: number;
  x?: number;
  y?: number;
}

export interface ForceLink {
  source: string;
  target: string;
  edgeId: string;
  relation: string;
  strength: number;
  fact: string;
  color: string;
  width: number;
}

/**
 * A force-graph node after d3-force has had a chance to touch it. The
 * simulation mutates `.x/.y/.vx/.vy` (and `.fx/.fy` when pinned) directly
 * on the object, so reusing the same object across rebuilds is the most
 * reliable way to preserve a node's layout — no copying, no tick-sync,
 * no jitter.
 */
export type MutableForceNode = ForceNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  // d3-force treats `undefined` as "not pinned"; a numeric value pins the
  // node to that coordinate. We never assign `null`.
  fx?: number;
  fy?: number;
};
