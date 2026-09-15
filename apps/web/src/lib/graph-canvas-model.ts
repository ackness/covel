import type { ForceLink, ForceNode } from "./graph-types.js";

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
  invalidAt?: number;
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
    (record.type === "individual" ||
      record.type === "group" ||
      record.type === "faction")
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

export function buildNodes(nodes: Record<string, unknown>): ForceNode[] {
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

export function buildLinks(edges: Record<string, unknown>): ForceLink[] {
  return Object.values(edges)
    .filter(isGraphEdgeRecord)
    .filter((edge) => edge.invalidAt === undefined)
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

export function drawNodeLabel(
  ctx: CanvasRenderingContext2D,
  node: ForceNode,
  x: number,
  y: number,
  _globalScale: number,
  selected: boolean,
): void {
  const lines = splitNodeLabel(node.name);
  const fontSize = Math.max(
    8,
    Math.min(
      12,
      (node.radius * 0.8) /
        Math.max(...lines.map((line) => Array.from(line).length), 1),
    ),
  );
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
