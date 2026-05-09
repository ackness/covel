import { nestedToFlat } from "@json-render/core";
import type { Spec } from "@json-render/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function pluginPanelViewToSpec(view: unknown): Spec | null {
  if (!isRecord(view)) return null;
  return nestedToFlat(rewriteComponentToType(view));
}

export function rewriteComponentToType(
  node: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "component") {
      result.type = value;
    } else if (key === "children" && Array.isArray(value)) {
      result.children = value.map((child) => {
        if (isRecord(child)) return rewriteComponentToType(child);
        return child;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function specUsesComponent(node: unknown, component: string): boolean {
  if (!isRecord(node)) return false;
  if (node.component === component || node.type === component) return true;
  const children = node.children;
  if (Array.isArray(children)) {
    return children.some((child) => specUsesComponent(child, component));
  }
  return false;
}
