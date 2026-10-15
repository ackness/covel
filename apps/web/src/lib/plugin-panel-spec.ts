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
    } else if (key === "slots" && isRecord(value)) {
      result.slots = Object.fromEntries(
        Object.entries(value).map(([slotName, slotChildren]) => [
          slotName,
          Array.isArray(slotChildren)
            ? slotChildren.map((child) => {
                if (isRecord(child)) return rewriteComponentToType(child);
                return child;
              })
            : slotChildren,
        ]),
      );
    } else {
      result[key] = value;
    }
  }
  if (result.type === "FilterContainer" && isRecord(result.props)) {
    const { itemTemplate, ...props } = result.props;
    // Keep the subtree out of props: json-render resolves props before the
    // component can introduce a row scope. Child elements stay lazy React
    // elements and resolve only under FilterContainer's RepeatScopeProvider.
    result.children = isRecord(itemTemplate)
      ? [rewriteComponentToType(itemTemplate)]
      : [];
    // Expose the original array path through json-render's public bindings
    // API, so filtering never changes $bindItem or nested repeat targets.
    if (isRecord(props.items)) {
      if (typeof props.items.$state === "string")
        props.items = { $bindState: props.items.$state };
      else if (typeof props.items.$item === "string")
        props.items = { $bindItem: props.items.$item };
    }
    result.props = props;
  }
  return result;
}

export function specUsesComponent(node: unknown, component: string): boolean {
  if (!isRecord(node)) return false;
  if (node.component === component || node.type === component) return true;
  if (
    (node.component === "FilterContainer" || node.type === "FilterContainer") &&
    isRecord(node.props) &&
    specUsesComponent(node.props.itemTemplate, component)
  )
    return true;
  const children = node.children;
  if (Array.isArray(children)) {
    if (children.some((child) => specUsesComponent(child, component))) {
      return true;
    }
  }
  const slots = node.slots;
  if (isRecord(slots)) {
    return Object.values(slots).some(
      (slotChildren) =>
        Array.isArray(slotChildren) &&
        slotChildren.some((child) => specUsesComponent(child, component)),
    );
  }
  return false;
}
