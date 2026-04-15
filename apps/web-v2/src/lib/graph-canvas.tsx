/**
 * GraphCanvas — react-force-graph-2d wrapper for json-render catalog.
 *
 * Renders a force-directed relationship graph from the live pluginData
 * store. Designed to plug into PluginPanel via a JSON spec that points
 * at a plugin ID and two namespaces that hold nodes and edges.
 *
 * Lazy-loaded via React.lazy so the force-graph + d3 bundle is only
 * pulled in when the user actually opens the NPC tab.
 */

import { Suspense, lazy, useMemo, useState, useRef, useEffect, useCallback } from "react";
import type { ComponentRenderer } from "@json-render/react";
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

interface PositionedNode extends ForceNode {
  x?: number;
  y?: number;
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

// ── Data adapters ────────────────────────────────────────────────

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

function seedNodePositions(nodes: ForceNode[], width: number, height: number): ForceNode[] {
  if (nodes.length === 0) return nodes;

  const cx = width / 2;
  const cy = height / 2;
  const seedRadius = Math.min(width, height) * 0.28;
  return nodes.map((node, index) => {
    const angle = (-Math.PI / 2) + (index / Math.max(nodes.length, 1)) * 2 * Math.PI;
    return {
      ...node,
      x: cx + Math.cos(angle) * seedRadius,
      y: cy + Math.sin(angle) * seedRadius,
    };
  });
}

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
  globalScale: number,
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

// ── Component ────────────────────────────────────────────────────

const Inner = ({ pluginId, nodesNamespace, edgesNamespace, height = 480 }: GraphCanvasProps) => {
  const nodes = usePluginNamespace(pluginId, nodesNamespace);
  const edges = usePluginNamespace(pluginId, edgesNamespace);
  const graphRef = useRef<any>(null);

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

  const graphData = useMemo(() => {
    const builtNodes = buildNodes(nodes);
    return {
      nodes: seedNodePositions(builtNodes, width, height),
      links: buildLinks(edges),
    };
  }, [nodes, edges, width, height]);

  useEffect(() => {
    if (!graphRef.current) return;
    const chargeForce = graphRef.current.d3Force("charge");
    const linkForce = graphRef.current.d3Force("link");
    const collisionForce = graphRef.current.d3Force("collision");

    chargeForce?.strength?.(-320);
    linkForce?.distance?.((link: ForceLink) => 110 + Math.abs(link.strength) * 30);
    collisionForce?.radius?.((node: PositionedNode) => node.radius + 16);

    graphRef.current.d3VelocityDecay?.(0.28);
    graphRef.current.zoomToFit?.(250, 28);
  }, [graphData]);

  const handleNodeClick = useCallback((node: object) => {
    setSelected(node as ForceNode);
  }, []);

  if (graphData.nodes.length === 0) {
    return (
      <div className="text-xs text-zinc-400 italic px-3 py-6 text-center">
        关系图当前为空，等待新的图谱数据……
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
              drawNodeLabel(
                ctx,
                forceNode,
                forceNode.x ?? 0,
                forceNode.y ?? 0,
                globalScale,
                selected?.id === forceNode.id,
              );
            }}
            nodeCanvasObjectMode={() => "replace"}
            nodePointerAreaPaint={(node: object, color: string, ctx) => {
              const forceNode = node as ForceNode & { x?: number; y?: number };
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(forceNode.x ?? 0, forceNode.y ?? 0, forceNode.radius, 0, 2 * Math.PI, false);
              ctx.fill();
            }}
            nodeLabel={(n: object) => {
              const fn = n as ForceNode;
              return `${fn.name} — ${fn.type}`;
            }}
            linkColor={(l: object) => (l as ForceLink).color}
            linkWidth={(l: object) => Math.max(2.5, (l as ForceLink).width)}
            linkDirectionalArrowColor={(l: object) => (l as ForceLink).color}
            linkDirectionalArrowLength={8}
            linkDirectionalArrowRelPos={0.9}
            linkCurvature={0.28}
            linkLabel={(l: object) => {
              const fl = l as ForceLink;
              return fl.fact;
            }}
            onNodeClick={handleNodeClick}
            onNodeDragEnd={(node: object) => {
              const dragged = node as ForceNode & { fx?: number; fy?: number; x?: number; y?: number };
              dragged.fx = dragged.x;
              dragged.fy = dragged.y;
            }}
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
