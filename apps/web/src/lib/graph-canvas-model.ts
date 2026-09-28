import type { ForceLink, ForceNode } from "./graph-types.js";
import type { GraphCanvasProps } from "@covel/shared";

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    isRecord(entry) ? [{ key, ...entry }] : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function read(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(/[/.]/).filter(Boolean)) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function buildNodes(
  recordsValue: unknown,
  fields: GraphCanvasProps["node"],
): ForceNode[] {
  return records(recordsValue).flatMap((record) => {
    const id = read(record, fields.idField);
    const name = read(record, fields.labelField);
    if (typeof id !== "string" || !id || typeof name !== "string" || !name)
      return [];
    const type = read(record, fields.typeField);
    const summary = read(record, fields.summaryField);
    const labels = read(record, fields.labelsField);
    const kind = typeof type === "string" ? type : "";
    return [
      {
        id,
        name,
        type: kind,
        summary: typeof summary === "string" ? summary : "",
        labels: Array.isArray(labels)
          ? labels.filter((label): label is string => typeof label === "string")
          : [],
        color: Object.hasOwn(fields.colors, kind)
          ? fields.colors[kind]
          : fields.defaultColor,
        radius: nodeRadius(name),
      },
    ];
  });
}

export function buildLinks(
  recordsValue: unknown,
  fields: GraphCanvasProps["edge"],
): ForceLink[] {
  return records(recordsValue).flatMap((record) => {
    if (read(record, fields.inactiveField) !== undefined) return [];
    const id = read(record, fields.idField);
    const source = read(record, fields.sourceField);
    const target = read(record, fields.targetField);
    const strength = read(record, fields.strengthField);
    if (
      typeof id !== "string" ||
      !id ||
      typeof source !== "string" ||
      !source ||
      typeof target !== "string" ||
      !target ||
      typeof strength !== "number" ||
      !Number.isFinite(strength)
    )
      return [];
    const relation = read(record, fields.relationField);
    const fact = read(record, fields.factField);
    const color =
      strength >= 0.33
        ? fields.colors.positive
        : strength <= -0.33
          ? fields.colors.negative
          : fields.colors.neutral;
    return [
      {
        source,
        target,
        edgeId: id,
        relation: typeof relation === "string" ? relation : "",
        strength,
        fact: typeof fact === "string" ? fact : "",
        color,
        width: 1 + Math.abs(strength) * 2,
      },
    ];
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
