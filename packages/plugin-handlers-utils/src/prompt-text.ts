/**
 * Replace every `{{ path }}` with what `render` returns for the trimmed path.
 * A scan, not `/\{\{\s*([^}]+?)\s*\}\}/g`: that expression matches the same
 * text, but takes cubic time on `{{` followed by a long run of whitespace.
 * `interpolateTemplate` in `@covel/context` has the same scan.
 */
function replaceVariables(
  template: string,
  render: (path: string) => string,
): string {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const open = template.indexOf("{{", from);
    if (open < 0) break;
    const close = template.indexOf("}", open + 2);
    if (close < 0) break;
    if (close === open + 2 || template[close + 1] !== "}") {
      // Not a variable, and none can start before this `}`.
      from = close + 1;
      continue;
    }
    out +=
      template.slice(copied, open) +
      render(template.slice(open + 2, close).trim());
    copied = from = close + 2;
  }
  return out + template.slice(copied);
}

/** Fill a flat string/number variable map; unknown paths render empty. */
export function interpolate(
  template: string,
  variables: Readonly<Record<string, string | number>>,
): string {
  return replaceVariables(template, (path) => {
    let value: unknown = variables;
    for (const key of path.split("."))
      value =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return value === undefined || value === null ? "" : String(value);
  });
}
