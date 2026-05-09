export function buildPluginPanelInitialState(
  data: Record<string, unknown>,
  invokingMap: Record<string, true>,
): Record<string, unknown> {
  const entries = Object.entries(data).map(([key, value]) => ({ key, value }));
  return { ...expandIndexedState(data), entries, _invoking: invokingMap };
}

export function flattenStateForPluginPanel(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  flattenStateValue(updates, "", value);
  return updates;
}

function flattenStateValue(
  updates: Record<string, unknown>,
  basePath: string,
  value: unknown,
): void {
  if (Array.isArray(value)) {
    updates[basePath || "/"] = value;
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      flattenStateValue(updates, `${basePath}/${key}`, child);
    }
    return;
  }
  updates[basePath || "/"] = value;
}

export function expandIndexedState(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const expanded: Record<string, unknown> = { ...data };

  for (const [key, value] of Object.entries(data)) {
    flattenIndexedValue(expanded, singularize(key), value);
  }

  return expanded;
}

function flattenIndexedValue(
  target: Record<string, unknown>,
  baseKey: string,
  value: unknown,
): void {
  if (!Array.isArray(value)) return;

  value.forEach((item, index) => {
    const itemKey = `${baseKey}${index + 1}`;
    if (Array.isArray(item)) {
      item.forEach((entry, entryIndex) => {
        target[`${itemKey}${entryIndex + 1}`] = entry;
      });
      return;
    }

    if (item && typeof item === "object") {
      for (const [childKey, childValue] of Object.entries(
        item as Record<string, unknown>,
      )) {
        const nestedKey = `${itemKey}${capitalize(childKey)}`;
        if (Array.isArray(childValue)) {
          flattenIndexedValue(target, nestedKey, childValue);
        } else if (childValue && typeof childValue === "object") {
          for (const [innerKey, innerValue] of Object.entries(
            childValue as Record<string, unknown>,
          )) {
            target[`${nestedKey}${capitalize(innerKey)}`] = innerValue;
          }
        } else {
          target[nestedKey] = childValue;
        }
      }
      return;
    }

    target[itemKey] = item;
  });
}

function singularize(value: string): string {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function capitalize(value: string): string {
  return value.length > 0
    ? `${value[0].toUpperCase()}${value.slice(1)}`
    : value;
}
