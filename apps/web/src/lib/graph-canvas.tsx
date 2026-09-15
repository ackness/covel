/**
 * GraphCanvas — react-force-graph-2d wrapper for json-render catalog.
 *
 * Renders a force-directed relationship graph from the live pluginData
 * store. Lazy-loaded so the force-graph + d3 bundle is only pulled in
 * when the user actually opens the NPC tab.
 */

import {
  Suspense,
  lazy,
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type ComponentProps,
  type ComponentType,
  type Ref,
} from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import {
  GraphRelationships,
  linkTouches,
  connectedNodeIds,
} from "./graph-relationships.js";
import { buildNodes, buildLinks, drawNodeLabel } from "./graph-canvas-model.js";
import { useTranslation } from "react-i18next";
import type { ComponentRenderer } from "@json-render/react";
import type { ForceGraphMethods } from "react-force-graph-2d";
import { usePluginNamespace } from "@/stores/plugin-data-store.js";
import type { ForceLink, ForceNode, MutableForceNode } from "./graph-types.js";
import { createGraphDataPools, syncGraphData } from "./graph-canvas-sync.js";

const ForceGraph2D = lazy(async () => {
  const mod = await import("react-force-graph-2d");
  // The wrapper uses React refs; its published type only lists object refs.
  type Props = Omit<ComponentProps<typeof mod.default>, "ref"> & {
    ref?: Ref<ForceGraphMethods>;
  };
  return { default: mod.default as ComponentType<Props> };
});

interface GraphCanvasProps {
  pluginId: string;
  nodesNamespace: string;
  edgesNamespace: string;
  height?: number;
}

const Inner = ({
  pluginId,
  nodesNamespace,
  edgesNamespace,
  height = 480,
}: GraphCanvasProps) => {
  const { t } = useTranslation();
  const nodes = usePluginNamespace(pluginId, nodesNamespace);
  const edges = usePluginNamespace(pluginId, edgesNamespace);
  // Keep the library's default structural node/link generics at the ref boundary.
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);

  const [selectedId, setSelectedId] = useState<string>();
  // React consumes immutable metadata; the simulation keeps its mutable pool.
  const viewData = useMemo(() => {
    const builtNodes = buildNodes(nodes);
    const ids = new Set(builtNodes.map((node) => node.id));
    return {
      nodes: builtNodes,
      links: buildLinks(edges).filter(
        (link) => ids.has(String(link.source)) && ids.has(String(link.target)),
      ),
    };
  }, [nodes, edges]);
  const selected = viewData.nodes.find((node) => node.id === selectedId);
  const connectedIds = useMemo(
    () => connectedNodeIds(viewData.links, selectedId),
    [viewData.links, selectedId],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);

  // Reuse node objects and pins; publish a new graph only when topology changes.
  const poolsRef = useRef(createGraphDataPools());
  // Latest canvas geometry held in a ref so the data-sync effect can read
  // it without depending on it — the effect deps stay limited to `nodes`
  // and `edges` so width changes never rebuild the graph.
  const canvasGeomRef = useRef({ width: 320, height });
  canvasGeomRef.current.width = width;
  canvasGeomRef.current.height = height;

  const [graphData, setGraphData] = useState(poolsRef.current.graphData);
  const fitPending = useRef(true);
  const fitGraph = useCallback(() => graphRef.current?.zoomToFit(250, 40), []);
  const attachGraph = useCallback((graph: ForceGraphMethods | null) => {
    graphRef.current = graph ?? undefined;
    if (!graph) return;
    graph.d3Force("charge")?.strength?.(-320);
    graph
      .d3Force("link")
      ?.distance?.((link: ForceLink) => 110 + Math.abs(link.strength) * 30);
    fitPending.current = true;
  }, []);

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
      const rounded = Math.max(1, Math.floor(entry.contentRect.width) - 2);
      setWidth((prev) => (prev === rounded ? prev : rounded));
    });
    // observe() synchronously fires once with the current geometry so
    // the initial width is picked up without an extra setWidth call.
    observer.observe(el);
    resizeObserverRef.current = observer;
  }, []);

  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  useEffect(
    () => () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    },
    [],
  );

  useEffect(() => {
    // Update pooled objects in place; notify the simulation only when the
    // topology changes so metadata updates preserve its positions and pins.
    const changed = syncGraphData(
      poolsRef.current,
      viewData,
      canvasGeomRef.current,
    );
    if (changed) {
      // Notify the simulation about topology; pooled nodes retain positions and pins.
      fitPending.current = true;
      setGraphData({ ...poolsRef.current.graphData });
    }
    if (selectedId && !poolsRef.current.nodePool.has(selectedId))
      setSelectedId(undefined);
  }, [viewData, selectedId]);

  useEffect(() => {
    fitPending.current = true;
    const frame = requestAnimationFrame(fitGraph);
    return () => cancelAnimationFrame(frame);
  }, [width, height, graphData, fitGraph]);

  const handleNodeClick = useCallback((node: object) => {
    setSelectedId((node as ForceNode).id);
  }, []);

  // IMPORTANT: `containerRef` must always be mounted — otherwise the
  // ResizeObserver effect below captures a null element on first run,
  // never re-observes when nodes later arrive, and the canvas width
  // stays frozen at its initial 320px no matter how the panel resizes.
  if (graphData.nodes.length === 0) {
    return (
      <div ref={containerCallbackRef} className="w-full">
        <div className="text-xs text-zinc-400 italic px-3 py-6 text-center">
          {t("graph.empty")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 w-full" ref={containerCallbackRef}>
      <div className="text-[10px] text-zinc-500 px-1 flex justify-between">
        <span>
          {t("graph.stats", {
            nodes: graphData.nodes.length,
            links: graphData.links.length,
          })}
        </span>
        {selected && (
          <button
            type="button"
            onClick={() => setSelectedId(undefined)}
            className="text-blue-500 hover:underline"
          >
            {t("graph.clearSelection")}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={fitGraph}
          aria-label={t("graph.fit")}
          title={t("graph.fit")}
          className="rounded border p-2 hover:bg-muted"
        >
          <Maximize className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            const graph = graphRef.current;
            if (graph) graph.zoom(graph.zoom() * 1.3, 200);
          }}
          aria-label={t("graph.zoomIn")}
          title={t("graph.zoomIn")}
          className="rounded border p-2 hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            const graph = graphRef.current;
            if (graph) graph.zoom(graph.zoom() / 1.3, 200);
          }}
          aria-label={t("graph.zoomOut")}
          title={t("graph.zoomOut")}
          className="rounded border p-2 hover:bg-muted"
        >
          <Minus className="h-4 w-4" />
        </button>
      </div>
      <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden bg-zinc-50 dark:bg-zinc-900/40">
        <Suspense
          fallback={
            <div
              className="flex items-center justify-center text-xs text-zinc-400"
              style={{ height }}
            >
              {t("graph.loading")}
            </div>
          }
        >
          <ForceGraph2D
            ref={attachGraph}
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
              ctx.save();
              if (selected && !connectedIds.has(forceNode.id))
                ctx.globalAlpha = 0.25;
              drawNodeLabel(
                ctx,
                forceNode,
                forceNode.x ?? 0,
                forceNode.y ?? 0,
                globalScale,
                selected?.id === forceNode.id,
              );
              ctx.restore();
            }}
            nodeCanvasObjectMode={() => "replace"}
            nodePointerAreaPaint={(node: object, color: string, ctx) => {
              const forceNode = node as ForceNode & { x?: number; y?: number };
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(
                forceNode.x ?? 0,
                forceNode.y ?? 0,
                forceNode.radius,
                0,
                2 * Math.PI,
                false,
              );
              ctx.fill();
            }}
            nodeLabel={(n: object) =>
              `${(n as ForceNode).name} — ${(n as ForceNode).type}`
            }
            linkColor={(l: object) =>
              selected && !linkTouches(l as ForceLink, selected.id)
                ? "rgba(148,163,184,0.12)"
                : (l as ForceLink).color
            }
            linkWidth={(l: object) => Math.max(2.5, (l as ForceLink).width)}
            linkDirectionalArrowColor={(l: object) =>
              selected && !linkTouches(l as ForceLink, selected.id)
                ? "rgba(148,163,184,0.12)"
                : (l as ForceLink).color
            }
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
              if (fitPending.current) {
                fitPending.current = false;
                fitGraph();
              }
              for (const node of poolsRef.current.graphData.nodes) {
                if (typeof node.x === "number" && node.fx === undefined)
                  node.fx = node.x;
                if (typeof node.y === "number" && node.fy === undefined)
                  node.fy = node.y;
              }
            }}
            cooldownTicks={120}
          />
        </Suspense>
      </div>
      <GraphRelationships
        nodes={viewData.nodes}
        links={viewData.links}
        selectedId={selected?.id}
        onSelect={handleNodeClick}
      />
      {selected && (
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md p-2.5 text-xs space-y-1">
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: selected.color }}
            />
            <span className="font-semibold">{selected.name}</span>
            <span className="text-[10px] text-zinc-500 uppercase">
              {selected.type}
            </span>
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

export const GraphCanvas: ComponentRenderer = ({ element }) => {
  const props = (element.props ?? {}) as Partial<GraphCanvasProps>;
  if (!props.pluginId || !props.nodesNamespace || !props.edgesNamespace) {
    return (
      <div className="text-xs text-red-500 italic">
        GraphCanvas: missing required props (pluginId, nodesNamespace,
        edgesNamespace)
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
