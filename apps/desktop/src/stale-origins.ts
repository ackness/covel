/**
 * Page origins of earlier launches that left storage behind.
 *
 * The page origin includes the sidecar port. The port is kept from one launch
 * to the next, but it changes when another process holds it, and an install
 * from before the port was kept has one origin per launch. What an old origin
 * stored (the media cache, the panel layout) is never read again. Chromium
 * names an origin's IndexedDB directory after the origin, so the names of
 * those directories list the origins.
 *
 * Kept free of any Electron import so the decision stays unit-testable.
 */
export function staleLoopbackOrigins(
  indexedDbEntries: readonly string[],
  currentPort: number,
): string[] {
  const ports = new Set<number>();
  for (const entry of indexedDbEntries) {
    const match =
      /^http_127\.0\.0\.1_(\d{1,5})\.indexeddb\.(?:leveldb|blob)$/.exec(entry);
    if (match) ports.add(Number(match[1]));
  }
  ports.delete(currentPort);
  return [...ports]
    .sort((a, b) => a - b)
    .map((port) => `http://127.0.0.1:${port}`);
}
