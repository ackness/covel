/**
 * Simple mustache-style {{variable}} template interpolation.
 * No conditionals/loops — keep templates purely declarative.
 * Unmatched variables are left as-is for debugging visibility.
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in vars ? vars[key] : match,
  );
}
