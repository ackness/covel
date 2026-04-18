/**
 * GraphCanvas — react-force-graph-2d wrapper for json-render catalog.
 *
 * Renders a force-directed relationship graph from the live pluginData
 * store. Lazy-loaded so the force-graph + d3 bundle is only pulled in
 * when the user actually opens the NPC tab.
 *
 * Migrated from web-v2.
 */

import { Suspense, lazy, useMemo, useState, useRef, useEffect, useCallback } from "react";
import type { ComponentRenderer } from "@json-render/react";
import { usePluginNamespace } from "@/stores/plugin-data-store.js";

const ForceGraph2D = lazy(async () => {
  const mod = await import("react-force-graph-2d");
  return { default: mod.default };
});

interface ForceNode {
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

interface ForceLink {
  source: string;
  target: string;
  edgeId: string;
  relation: string;
  strength: number;
  fact: string;
  color: string;
  width: number;
}

interface GraphNodeRecord {
  id: string;
  name: string;
  type: "individual" | "group" | "faction";
  summary?: string;
  labels?: readonly string[];
}

interface GraphEdgeRecord {
  id: string;
  source: string;
  target: string;
  relation: string;
  strength: number;
  fact?: string;
}

interface GraphCanvasProps {
  pluginId: string;
  nodesNamespace: string;
  edgesNamespace: string;
  height?: number;
}

const NODE_COLORS = {
  individual: "#60a5fa",
  group: "#a78bfa",
  faction: "#f59e0b",
} as const;

const POSITIVE_EDGE = "#22c55e";
const NEGATIVE_EDGE = "#ef4444";
const NEUTRAL_EDGE = "#94a3b8";

function pickEdgeColor(strength: number): string {
  if (strength >= 0.33) return POSITIVE_EDGE;
  if (strength <= -0.33) return NEGATIVE_EDGE;
  return NEUTRAL_EDGE;
}

function isGraphNodeRecord(value: unknown): value is GraphNodeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    (record.type === "individual" || record.type === "group" || record.type === "faction")
  );
}

function isGraphEdgeRecord(value: unknown): value is GraphEdgeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.source === "string" &&
    typeof record.target === "string" &&
    typeof record.relation === "string" &&
    typeof record.strength === "number"
  );
}

function buildNodes(nodes: Record<string, unknown>): ForceNode[] {
  return Object.values(nodes)
    .filter(isGraphNodeRecord)
    .map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      summary: node.summary ?? "",
      labels: [...(node.labels ?? [])],
      color: NODE_COLORS[node.type] ?? "#9ca3af",
      radius: nodeRadius(node.name),
    }));
}

function buildLinks(edges: Record<string, unknown>): ForceLink[] {
  return Object.values(edges)
    .filter(isGraphEdgeRecord)
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      edgeId: edge.id,
      relation: edge.relation,
      strength: edge.strength,
      fact: edge.fact ?? "",
      color: pickEdgeColor(edge.strength),
      width: 1 + Math.abs(edge.strength) * 2,
    }));
}

/**
 * A force-graph node after d3-force has had a chance to touch it. The
 * simulation mutates `.x/.y/.vx/.vy` (and `.fx/.fy` when pinned) directly
 * on the object, so reusing the same object across rebuilds is the most
 * reliable way to preserve a node's layout — no copying, no tick-sync,
 * no jitter.
 */
type MutableForceNode = ForceNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  // d3-force treats `undefined` as "not pinned"; a numeric value pins the
  // node to that coordinate. We never assign `null`.
  fx?: number;
  fy?: number;
};

function nodeRadius(name: string): number {
  const glyphs = Array.from(name ?? "");
  return Math.max(18, Math.min(32, 14 + Math.max(0, glyphs.length - 2) * 2.6));
}

function splitNodeLabel(name: string): string[] {
  const glyphs = Array.from(name ?? "");
  if (glyphs.length <= 4) return [glyphs.join("")];
  const middle = Math.ceil(glyphs.length / 2);
  return [glyphs.slice(0, middle).join(""), glyphs.slice(middle).join("")];
}

function drawNodeLabel(
  ctx: CanvasRenderingContext2D,
  node: ForceNode,
  x: number,
  y: number,
  _globalScale: number,
  selected: boolean,
): void {
  const lines = splitNodeLabel(node.name);
  const fontSize = Math.max(8, Math.min(12, (node.radius * 0.8) / Math.max(...lines.map((line) => Array.from(line).length), 1)));
  const lineHeight = fontSize + 1;

  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = node.color;
  ctx.arc(x, y, node.radius, 0, 2 * Math.PI, false);
  ctx.fill();

  ctx.lineWidth = selected ? 2.5 : 1.25;
  ctx.strokeStyle = selected ? "#f8fafc" : "rgba(255,255,255,0.32)";
  ctx.stroke();

  ctx.fillStyle = "#f8fafc";
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  for (const [index, line] of lines.entries()) {
    ctx.fillText(line, x, startY + index * lineHeight);
  }

  ctx.restore();
}

const Inner = ({ pluginId, nodesNamespace, edgesNamespace, height = 480 }: GraphCanvasProps) => {
  const nodes = usePluginNamespace(pluginId, nodesNamespace);
  const edges = usePluginNamespace(pluginId, edgesNamespace);
  const graphRef = useRef<any>(null);

  const [selected, setSelected] = useState<ForceNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);

  // ── Stable graphData (the key to no-drift) ───────────────────────
  //
  // `react-force-graph` compares `graphData` by reference: every new
  // reference it sees triggers an alpha=1 simulation restart. With the
  // centre force kicking in on each restart the whole graph drifts in
  // whichever direction the first few ticks happen to push it. V2 got
  // away with the naive "rebuild on every render" because plugin-data
  // rarely changed there; V1's `plugin-data.changed` SSE channel fires
  // far more frequently and exposes the underlying instability.
  //
  // Fix: keep ONE `{nodes, links}` object behind a ref and mutate its
  // arrays in place whenever plugin-data changes. The ref never changes
  // identity, so force-graph's simulation state is preserved.
  //
  // Canvas width is handled orthogonally: it only flows into the `width`
  // prop of `<ForceGraph2D>` (force-graph handles reflow internally) and
  // into the *initial* seed position of brand-new nodes. It never
  // triggers graphData rebuilds.
  const graphDataRef = useRef<{ nodes: MutableForceNode[]; links: ForceLink[] }>({ nodes: [], links: [] });
  const nodePoolRef = useRef<Map<string, MutableForceNode>>(new Map());
  const linkPoolRef = useRef<Map<string, ForceLink>>(new Map());
  // Latest canvas geometry held in a ref so the data-sync effect can read
  // it without depending on it — the effect deps stay limited to `nodes`
  // and `edges` so width changes never rebuild the graph.
  const canvasGeomRef = useRef({ width: 320, height });
  canvasGeomRef.current.width = width;
  canvasGeomRef.current.height = height;

  const [, setTick] = useState(0);
  const lastFitCountRef = useRef<number>(-1);

  // Attach the observer through a callback ref so we always connect to
  // whatever DOM node the latest render produced (e.g. empty-state <div>
  // vs full graph wrapper). Using a plain `useEffect(..., [])` would only
  // look at `containerRef.current` once, which misses the mount point.
  const containerCallbackRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Canvas占容器的92%宽度 — 避免右侧 panel padding 把画布推出可视区。
      const rounded = Math.max(200, Math.round(entry.contentRect.width * 0.92));
      setWidth((prev) => (prev === rounded ? prev : rounded));
    });
    // observe() synchronously fires once with the current geometry so
    // the initial width is picked up without an extra setWidth call.
    observer.observe(el);
    resizeObserverRef.current = observer;
  }, []);

  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  useEffect(() => () => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
  }, []);

  useEffect(() => {
    // Sync plugin-data → in-place mutation of the stable graphData ref.
    // Only setTick when the id-set actually changed so mid-drag echoes
    // from other plugins don't force React to re-render this tree.
    const built = buildNodes(nodes);
    const pool = nodePoolRef.current;
    const currentNodes = graphDataRef.current.nodes;
    const liveNodeIds = new Set<string>();
    let nodesChanged = false;

    const geom = canvasGeomRef.current;
    const cx = geom.width / 2;
    const cy = geom.height / 2;
    const seedRadius = Math.min(geom.width, geom.height) * 0.28;
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
      const idx = newcomerIds.indexOf(n.id);
      const angle = -Math.PI / 2 + (idx / Math.max(newcomerIds.length, 1)) * 2 * Math.PI;
      const seeded: MutableForceNode = {
        ...n,
        x: cx + Math.cos(angle) * seedRadius,
        y: cy + Math.sin(angle) * seedRadius,
      };
      pool.set(n.id, seeded);
      currentNodes.push(seeded);
      nodesChanged = true;
    }
    for (let i = currentNodes.length - 1; i >= 0; i -= 1) {
      if (!liveNodeIds.has(currentNodes[i].id)) {
        pool.delete(currentNodes[i].id);
        currentNodes.splice(i, 1);
        nodesChanged = true;
      }
    }

    const linkPool = linkPoolRef.current;
    const currentLinks = graphDataRef.current.links;
    const builtLinks = buildLinks(edges);
    const liveLinkIds = new Set<string>();
    let linksChanged = false;

    for (const l of builtLinks) {
      liveLinkIds.add(l.edgeId);
      const existing = linkPool.get(l.edgeId);
      if (existing) {
        existing.relation = l.relation;
        existing.strength = l.strength;
        existing.fact = l.fact;
        existing.color = l.color;
        existing.width = l.width;
        continue;
      }
      linkPool.set(l.edgeId, l);
      currentLinks.push(l);
      linksChanged = true;
    }
    for (let i = currentLinks.length - 1; i >= 0; i -= 1) {
      if (!liveLinkIds.has(currentLinks[i].edgeId)) {
        linkPool.delete(currentLinks[i].edgeId);
        currentLinks.splice(i, 1);
        linksChanged = true;
      }
    }

    if (nodesChanged || linksChanged) {
      setTick((t) => t + 1);
    }
  }, [nodes, edges]);

  const graphData = graphDataRef.current;

  useEffect(() => {
    if (!graphRef.current) return;
    const chargeForce = graphRef.current.d3Force("charge");
    const linkForce = graphRef.current.d3Force("link");
    const collisionForce = graphRef.current.d3Force("collision");

    chargeForce?.strength?.(-320);
    linkForce?.distance?.((link: ForceLink) => 110 + Math.abs(link.strength) * 30);
    collisionForce?.radius?.((node: MutableForceNode) => node.radius + 16);

    graphRef.current.d3VelocityDecay?.(0.28);
    // Auto-fit on topology change (new node added) so the user sees the
    // updated graph. Doesn't restart the simulation — camera-only op.
    const count = graphData.nodes.length;
    if (lastFitCountRef.current !== count) {
      lastFitCountRef.current = count;
      graphRef.current.zoomToFit?.(250, 28);
    }
  }, [graphData, graphData.nodes.length]);

  // Intentionally no "refit on width change" effect here — calling
  // zoomToFit on every ResizeObserver notification was racing with
  // react-force-graph's internal canvas resize and reintroduced the
  // drift. The canvas still resizes (the `width` prop propagates) and
  // node positions stay put; the user can drag/zoom to recentre.

  const handleNodeClick = useCallback((node: object) => {
    setSelected(node as ForceNode);
  }, []);

  // IMPORTANT: `containerRef` must always be mounted — otherwise the
  // ResizeObserver effect below captures a null element on first run,
  // never re-observes when nodes later arrive, and the canvas width
  // stays frozen at its initial 320px no matter how the panel resizes.
  if (graphData.nodes.length === 0) {
    return (
      <div ref={containerCallbackRef} className="w-full">
        <div className="text-xs text-zinc-400 italic px-3 py-6 text-center">
          关系图当前为空，等待新的图谱数据……
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 w-full" ref={containerCallbackRef}>
      <div className="text-[10px] text-zinc-500 px-1 flex justify-between">
        <span>{graphData.nodes.length} 个节点 · {graphData.links.length} 条关系</span>
        {selected && (
          <button type="button" onClick={() => setSelected(null)} className="text-blue-500 hover:underline">
            清除选中
          </button>
        )}
      </div>
      <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden bg-zinc-50 dark:bg-zinc-900/40">
        <Suspense fallback={<div className="flex items-center justify-center text-xs text-zinc-400" style={{ height }}>加载关系图……</div>}>
          <ForceGraph2D
            ref={graphRef}
            graphData={graphData}
            width={width}
            height={height}
            backgroundColor="rgba(0,0,0,0)"
            enablePanInteraction={true}
            enableZoomInteraction={true}
            enableNodeDrag={true}
            nodeRelSize={6}
            nodeColor={(n: object) => (n as ForceNode).color}
            nodeVal={(n: object) => (n as ForceNode).radius}
            nodeCanvasObject={(node: object, ctx, globalScale) => {
              const forceNode = node as ForceNode & { x?: number; y?: number };
              drawNodeLabel(ctx, forceNode, forceNode.x ?? 0, forceNode.y ?? 0, globalScale, selected?.id === forceNode.id);
            }}
            nodeCanvasObjectMode={() => "replace"}
            nodePointerAreaPaint={(node: object, color: string, ctx) => {
              const forceNode = node as ForceNode & { x?: number; y?: number };
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(forceNode.x ?? 0, forceNode.y ?? 0, forceNode.radius, 0, 2 * Math.PI, false);
              ctx.fill();
            }}
            nodeLabel={(n: object) => `${(n as ForceNode).name} — ${(n as ForceNode).type}`}
            linkColor={(l: object) => (l as ForceLink).color}
            linkWidth={(l: object) => Math.max(2.5, (l as ForceLink).width)}
            linkDirectionalArrowColor={(l: object) => (l as ForceLink).color}
            linkDirectionalArrowLength={8}
            linkDirectionalArrowRelPos={0.9}
            linkCurvature={0.28}
            linkLabel={(l: object) => (l as ForceLink).fact}
            onNodeClick={handleNodeClick}
            onNodeDragEnd={(node: object) => {
              const dragged = node as MutableForceNode;
              if (typeof dragged.x === "number") dragged.fx = dragged.x;
              if (typeof dragged.y === "number") dragged.fy = dragged.y;
            }}
            // When the simulation first settles, PIN every node at its
            // current position. Any later reheat (new edge/node pushed
            // in by an agent) can only move still-unpinned nodes — the
            // stable graph stays exactly where it is. This is the d3-
            // force idiom for "layout once, then behave as a static
            // diagram" and is what eliminates the agent-driven drift.
            onEngineStop={() => {
              for (const node of graphDataRef.current.nodes) {
                if (typeof node.x === "number" && node.fx === undefined) node.fx = node.x;
                if (typeof node.y === "number" && node.fy === undefined) node.fy = node.y;
              }
            }}
            cooldownTicks={120}
          />
        </Suspense>
      </div>
      {selected && (
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md p-2.5 text-xs space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: selected.color }} />
            <span className="font-semibold">{selected.name}</span>
            <span className="text-[10px] text-zinc-500 uppercase">{selected.type}</span>
          </div>
          {selected.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selected.labels.map((label) => (
                <span key={label} className="text-[9px] px-1 py-0.5 rounded-sm bg-zinc-100 dark:bg-zinc-800 text-zinc-500">{label}</span>
              ))}
            </div>
          )}
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400 leading-relaxed">{selected.summary}</p>
        </div>
      )}
    </div>
  );
};

export const GraphCanvas: ComponentRenderer = ({ element }) => {
  const props = (element.props ?? {}) as Partial<GraphCanvasProps>;
  if (!props.pluginId || !props.nodesNamespace || !props.edgesNamespace) {
    return (
      <div className="text-xs text-red-500 italic">
        GraphCanvas: missing required props (pluginId, nodesNamespace, edgesNamespace)
      </div>
    );
  }
  return (
    <Inner pluginId={props.pluginId} nodesNamespace={props.nodesNamespace} edgesNamespace={props.edgesNamespace} height={props.height} />
  );
};
