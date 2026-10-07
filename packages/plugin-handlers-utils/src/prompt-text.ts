/** Fill a flat string/number variable map; unknown paths render empty. */
export function interpolate(
  template: string,
  variables: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    let value: unknown = variables;
    for (const key of path.trim().split("."))
      value =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return value === undefined || value === null ? "" : String(value);
  });
}
