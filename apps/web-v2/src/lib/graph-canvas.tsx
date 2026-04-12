/**
 * GraphCanvas — react-force-graph-2d wrapper for json-render catalog.
 *
 * Renders a force-directed NPC relationship graph from the live
 * pluginData store. Designed to plug into PluginPanel via a JSON spec
 * that points at the plugin ID and the two namespaces (`nodes`,
 * `edges`) maintained by core-npc-graph.
 *
 * Lazy-loaded via React.lazy so the force-graph + d3 bundle is only
 * pulled in when the user actually opens the NPC tab.
 */

import { Suspense, lazy, useMemo, useState, useRef, useEffect, useCallback } from "react";
import type { ComponentRenderer } from "@json-render/react";
import type { NpcNode, NpcEdge } from "@covel/shared";
import { usePluginNamespace } from "@/stores/plugin-data-store.js";

// Defer the heavy d3-force + canvas bundle until first mount.
const ForceGraph2D = lazy(async () => {
  const mod = await import("react-force-graph-2d");
  return { default: mod.default };
});

// ── Types ────────────────────────────────────────────────────────

interface ForceNode {
  id: string;
  name: string;
  type: "individual" | "group" | "faction";
  summary: string;
  labels: string[];
  color: string;
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

interface GraphCanvasProps {
  pluginId: string;
  nodesNamespace: string;
  edgesNamespace: string;
  height?: number;
}

// ── Color palette ────────────────────────────────────────────────

const NODE_COLORS = {
  individual: "#60a5fa", // blue-400
  group: "#a78bfa",      // violet-400
  faction: "#f59e0b",    // amber-500
} as const;

const POSITIVE_EDGE = "#22c55e"; // green-500
const NEGATIVE_EDGE = "#ef4444"; // red-500
const NEUTRAL_EDGE = "#94a3b8";  // slate-400

function pickEdgeColor(strength: number): string {
  if (strength >= 0.33) return POSITIVE_EDGE;
  if (strength <= -0.33) return NEGATIVE_EDGE;
  return NEUTRAL_EDGE;
}

// ── Data adapters ────────────────────────────────────────────────

function buildNodes(nodes: Record<string, unknown>): ForceNode[] {
  return Object.values(nodes)
    .filter((v): v is NpcNode => Boolean(v) && typeof v === "object" && "id" in (v as object))
    .map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      summary: node.summary,
      labels: [...node.labels],
      color: NODE_COLORS[node.type] ?? "#9ca3af",
    }));
}

function buildLinks(edges: Record<string, unknown>): ForceLink[] {
  return Object.values(edges)
    .filter((v): v is NpcEdge => Boolean(v) && typeof v === "object" && "id" in (v as object))
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      edgeId: edge.id,
      relation: edge.relation,
      strength: edge.strength,
      fact: edge.fact,
      color: pickEdgeColor(edge.strength),
      width: 1 + Math.abs(edge.strength) * 2,
    }));
}

// ── Component ────────────────────────────────────────────────────

const Inner = ({ pluginId, nodesNamespace, edgesNamespace, height = 480 }: GraphCanvasProps) => {
  const nodes = usePluginNamespace(pluginId, nodesNamespace);
  const edges = usePluginNamespace(pluginId, edgesNamespace);

  const graphData = useMemo(
    () => ({ nodes: buildNodes(nodes), links: buildLinks(edges) }),
    [nodes, edges],
  );

  const [selected, setSelected] = useState<ForceNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(200, entry.contentRect.width));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleNodeClick = useCallback((node: object) => {
    setSelected(node as ForceNode);
  }, []);

  if (graphData.nodes.length === 0) {
    return (
      <div className="text-xs text-zinc-400 italic px-3 py-6 text-center">
        NPC 关系图为空，等待 narrator 推进剧情……
      </div>
    );
  }

  return (
    <div className="space-y-2" ref={containerRef}>
      <div className="text-[10px] text-zinc-500 px-1 flex justify-between">
        <span>{graphData.nodes.length} 个节点 · {graphData.links.length} 条关系</span>
        {selected && (
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="text-blue-500 hover:underline"
          >
            清除选中
          </button>
        )}
      </div>
      <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden bg-zinc-50 dark:bg-zinc-900/40">
        <Suspense
          fallback={
            <div
              className="flex items-center justify-center text-xs text-zinc-400"
              style={{ height }}
            >
              加载关系图……
            </div>
          }
        >
          <ForceGraph2D
            graphData={graphData}
            width={width}
            height={height}
            backgroundColor="rgba(0,0,0,0)"
            nodeRelSize={6}
            nodeColor={(n: object) => (n as ForceNode).color}
            nodeLabel={(n: object) => {
              const fn = n as ForceNode;
              return `${fn.name} — ${fn.type}`;
            }}
            linkColor={(l: object) => (l as ForceLink).color}
            linkWidth={(l: object) => (l as ForceLink).width}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={0.95}
            linkCurvature={0.15}
            linkLabel={(l: object) => {
              const fl = l as ForceLink;
              return `${fl.relation} (${fl.strength.toFixed(2)})\n${fl.fact}`;
            }}
            onNodeClick={handleNodeClick}
            cooldownTicks={120}
          />
        </Suspense>
      </div>
      {selected && (
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md p-2.5 text-xs space-y-1">
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: selected.color }}
            />
            <span className="font-semibold">{selected.name}</span>
            <span className="text-[10px] text-zinc-500 uppercase">{selected.type}</span>
          </div>
          {selected.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selected.labels.map((label) => (
                <span
                  key={label}
                  className="text-[9px] px-1 py-0.5 rounded-sm bg-zinc-100 dark:bg-zinc-800 text-zinc-500"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400 leading-relaxed">
            {selected.summary}
          </p>
        </div>
      )}
    </div>
  );
};

// json-render adapter — extracts props from element and forwards them to Inner.
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
    <Inner
      pluginId={props.pluginId}
      nodesNamespace={props.nodesNamespace}
      edgesNamespace={props.edgesNamespace}
      height={props.height}
    />
  );
};
