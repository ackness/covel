/**
 * graph-canvas-sync — pure pool-reconciliation for GraphCanvas.
 *
 * Mutates pooled nodes and links in place while reporting topology changes.
 * The view publishes a new graph wrapper only for those changes so d3 can
 * initialize newcomers. Existing x/y/vx/vy/fx/fy values are never touched here.
 */

import type { ForceLink, ForceNode, MutableForceNode } from "./graph-types.js";
import { endpointId } from "./graph-types.js";

interface CanvasGeometry {
  width: number;
  height: number;
}

export interface GraphDataPools {
  graphData: { nodes: MutableForceNode[]; links: ForceLink[] };
  nodePool: Map<string, MutableForceNode>;
  linkPool: Map<string, ForceLink>;
}

export function createGraphDataPools(): GraphDataPools {
  return {
    graphData: { nodes: [], links: [] },
    nodePool: new Map(),
    linkPool: new Map(),
  };
}

function seedPosition(
  geom: CanvasGeometry,
  index: number,
  total: number,
): { x: number; y: number } {
  // Force-graph world coordinates are centered on the origin.
  const cx = 0;
  const cy = 0;
  const seedRadius = Math.min(geom.width, geom.height) * 0.28;
  const angle = -Math.PI / 2 + (index / Math.max(total, 1)) * 2 * Math.PI;
  return {
    x: cx + Math.cos(angle) * seedRadius,
    y: cy + Math.sin(angle) * seedRadius,
  };
}

/**
 * Reconcile freshly built nodes into the stable pool. Existing nodes are
 * refreshed in place (visuals only); newcomers are seeded around a circle so
 * the simulation starts them in a sensible spot; vanished nodes are dropped.
 *
 * @returns whether the node id-set changed (i.e. a re-render is warranted).
 */
function syncNodes(
  pools: GraphDataPools,
  built: readonly ForceNode[],
  geom: CanvasGeometry,
): boolean {
  const { nodePool: pool, graphData } = pools;
  const currentNodes = graphData.nodes;
  const liveNodeIds = new Set<string>();
  let changed = false;

  const newcomerIds = built.map((n) => n.id).filter((id) => !pool.has(id));

  for (const n of built) {
    liveNodeIds.add(n.id);
    const existing = pool.get(n.id);
    if (existing) {
      // Refresh visuals in place; don't touch x/y/vx/vy/fx/fy.
      existing.name = n.name;
      existing.type = n.type;
      existing.summary = n.summary;
      existing.labels = n.labels;
      existing.color = n.color;
      existing.radius = n.radius;
      continue;
    }
    const { x, y } = seedPosition(
      geom,
      newcomerIds.indexOf(n.id),
      newcomerIds.length,
    );
    const seeded: MutableForceNode = { ...n, x, y };
    pool.set(n.id, seeded);
    currentNodes.push(seeded);
    changed = true;
  }

  for (let i = currentNodes.length - 1; i >= 0; i -= 1) {
    if (!liveNodeIds.has(currentNodes[i].id)) {
      pool.delete(currentNodes[i].id);
      currentNodes.splice(i, 1);
      changed = true;
    }
  }

  return changed;
}

/**
 * Reconcile freshly built links into the stable pool, mirroring `syncNodes`.
 *
 * @returns whether the link id-set or endpoints changed.
 */
function syncLinks(
  pools: GraphDataPools,
  builtLinks: readonly ForceLink[],
): boolean {
  const { linkPool, graphData } = pools;
  const currentLinks = graphData.links;
  const liveLinkIds = new Set<string>();
  let changed = false;

  for (const l of builtLinks) {
    liveLinkIds.add(l.edgeId);
    const existing = linkPool.get(l.edgeId);
    if (existing) {
      if (
        endpointId(existing.source) !== endpointId(l.source) ||
        endpointId(existing.target) !== endpointId(l.target)
      ) {
        // Reset resolved endpoints so d3 binds the new topology to its nodes.
        existing.source = endpointId(l.source);
        existing.target = endpointId(l.target);
        changed = true;
      }
      existing.relation = l.relation;
      existing.strength = l.strength;
      existing.fact = l.fact;
      existing.color = l.color;
      existing.width = l.width;
      continue;
    }
    const pooled = { ...l };
    linkPool.set(l.edgeId, pooled);
    currentLinks.push(pooled);
    changed = true;
  }

  for (let i = currentLinks.length - 1; i >= 0; i -= 1) {
    if (!liveLinkIds.has(currentLinks[i].edgeId)) {
      linkPool.delete(currentLinks[i].edgeId);
      currentLinks.splice(i, 1);
      changed = true;
    }
  }

  return changed;
}

/**
 * Sync both nodes and links into the stable pool.
 *
 * @returns whether an id-set or edge endpoints changed.
 */
export function syncGraphData(
  pools: GraphDataPools,
  built: { nodes: readonly ForceNode[]; links: readonly ForceLink[] },
  geom: CanvasGeometry,
): boolean {
  const nodesChanged = syncNodes(pools, built.nodes, geom);
  const linksChanged = syncLinks(pools, built.links);
  return nodesChanged || linksChanged;
}
