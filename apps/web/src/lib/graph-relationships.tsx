import { useTranslation } from "react-i18next";
import { endpointId, type ForceLink, type ForceNode } from "./graph-types.js";

export function linkTouches(link: ForceLink, nodeId: string): boolean {
  return (
    endpointId(link.source) === nodeId || endpointId(link.target) === nodeId
  );
}

/** Compute once per selection/topology change, outside the per-node painter. */
export function connectedNodeIds(
  links: readonly ForceLink[],
  selectedId: string | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!selectedId) return ids;
  ids.add(selectedId);
  for (const link of links) {
    if (linkTouches(link, selectedId)) {
      ids.add(endpointId(link.source));
      ids.add(endpointId(link.target));
    }
  }
  return ids;
}

/** Accessible navigation also works without interpreting the canvas geometry. */
export function GraphRelationships({
  nodes,
  links,
  selectedId,
  onSelect,
}: {
  nodes: readonly ForceNode[];
  links: readonly ForceLink[];
  selectedId?: string;
  onSelect: (node: ForceNode) => void;
}) {
  const { t } = useTranslation();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visible = selectedId
    ? links.filter((link) => linkTouches(link, selectedId))
    : links;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap gap-1" aria-label={t("graph.characters")}>
        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            aria-pressed={selectedId === node.id}
            onClick={() => onSelect(node)}
            className="rounded border px-2 py-1 aria-pressed:bg-primary/15 hover:bg-muted"
          >
            {node.name}
          </button>
        ))}
      </div>
      <details open={selectedId !== undefined}>
        <summary className="cursor-pointer py-1 text-muted-foreground">
          {t("graph.relationships", { count: visible.length })}
        </summary>
        <ul
          className="max-h-64 space-y-2 overflow-y-auto py-2"
          aria-label={t("graph.relationshipList")}
        >
          {visible.map((link) => (
            <li key={link.edgeId} className="border-l-2 border-border pl-2">
              {[link.source, link.target].map((endpoint, index) => {
                const node = byId.get(endpointId(endpoint));
                return (
                  <span key={index}>
                    {index === 1 && (
                      <span className="px-1 text-muted-foreground">
                        → {link.relation} →
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => node && onSelect(node)}
                      className="font-medium hover:underline"
                    >
                      {node?.name ?? endpointId(endpoint)}
                    </button>
                  </span>
                );
              })}
              {link.fact && (
                <p className="mt-1 text-muted-foreground">{link.fact}</p>
              )}
            </li>
          ))}
          {visible.length === 0 && (
            <li className="text-muted-foreground">
              {t("graph.noRelationships")}
            </li>
          )}
        </ul>
      </details>
    </div>
  );
}
