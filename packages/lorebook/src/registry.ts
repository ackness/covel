/**
 * Multi-layer lorebook registry.
 *
 * Responsibility: hold world / plugin / session entries in separate layers
 * and, on demand, produce the flattened merged list that the scanner runs
 * against.
 *
 * Merge precedence (from A3 of the improvement plan, lowest → highest):
 *
 *     world → plugin → session
 *
 * Higher layers override lower ones **by `id`** — a session entry wins
 * over a world entry with the same id, but an entry with a fresh id from
 * a higher layer is simply appended. This is the same "later layer wins"
 * model SillyTavern uses for its lorebook stack.
 *
 * The registry is intentionally a pure data holder. It doesn't load
 * anything, doesn't read the filesystem, and has no notion of sessions —
 * it's just a set-of-sets with deterministic merge rules. S3-T1 only ever
 * populates the world layer; S3-T2 will add plugin and session layers.
 */

import type { LorebookEntry, LorebookSource } from "./types.js";

const LAYER_ORDER: readonly LorebookSource[] = ["world", "plugin", "session"];

export class LorebookRegistry {
  private readonly layers = new Map<LorebookSource, Map<string, LorebookEntry>>();

  constructor() {
    for (const layer of LAYER_ORDER) {
      this.layers.set(layer, new Map());
    }
  }

  /**
   * Replace all entries in the given layer with `entries`. This is the
   * primary mutation API — layers are conceptually "owned" by different
   * systems (world loader, plugin loader, session store), and each owner
   * rewrites its own layer wholesale on changes.
   */
  setLayer(source: LorebookSource, entries: readonly LorebookEntry[]): void {
    const layer = this.requireLayer(source);
    layer.clear();
    for (const entry of entries) {
      layer.set(entry.id, entry);
    }
  }

  /** Upsert a single entry into a layer. */
  upsert(entry: LorebookEntry): void {
    const layer = this.requireLayer(entry.source);
    layer.set(entry.id, entry);
  }

  /** Remove an entry from a specific layer by id. No-op if not present. */
  remove(source: LorebookSource, id: string): void {
    this.requireLayer(source).delete(id);
  }

  /** List entries currently in a single layer. Useful for tests + debugging. */
  listLayer(source: LorebookSource): readonly LorebookEntry[] {
    return Array.from(this.requireLayer(source).values());
  }

  /**
   * Produce the flattened merged entry list in the order the scanner
   * expects: lowest-priority layer first, then higher layers overriding
   * earlier entries with the same id. An id from a higher layer replaces
   * the lower-layer entry at its own position in the output (the higher
   * layer's position), so later additions show up later in the list.
   */
  getMerged(): readonly LorebookEntry[] {
    // Two-pass: first resolve id → winning entry via the layer order,
    // then re-emit preserving the order of the winning layer's insertion.
    const winner = new Map<string, { entry: LorebookEntry; order: number }>();
    let cursor = 0;

    for (const source of LAYER_ORDER) {
      const layer = this.requireLayer(source);
      for (const entry of layer.values()) {
        winner.set(entry.id, { entry, order: cursor++ });
      }
    }

    return Array.from(winner.values())
      .sort((a, b) => a.order - b.order)
      .map(w => w.entry);
  }

  private requireLayer(source: LorebookSource): Map<string, LorebookEntry> {
    const layer = this.layers.get(source);
    if (!layer) {
      // Unreachable: LAYER_ORDER seeds every layer in the constructor.
      throw new Error(`[lorebook] unknown layer source: ${source}`);
    }
    return layer;
  }
}
