/**
 * Parse `.env`-style `KEY=VALUE` text.
 *
 * Splits on newlines, skips blank lines and `#` comments, trims both sides of
 * `=`, and strips one enclosing layer of matching single/double quotes from the
 * value. Empty keys are dropped. Returns entries in file order (last-wins is the
 * caller's concern).
 */
export function parseEnvLines(text: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    entries.push([key, val]);
  }
  return entries;
}
