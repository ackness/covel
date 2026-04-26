/**
 * Web-side runtime helpers for `MediaRef` payloads.
 *
 * The canonical type + zod schema live in `@covel/shared` (Codex P0-a).
 * The catalog renderer receives plugin-spec props as `unknown` JSON, so
 * we need a cheap structural check before routing into `<Media>`.
 *
 * `mediaRefSchema.safeParse(value)` would also work, but pulls zod into
 * a hot render path. The minimum shape (`id`/`mime`/`size`) is enough
 * for the resolver to function — `meta`/`url` are looked up later via
 * the schema where strictness matters (e.g. tool I/O validation).
 */

import type { MediaRef } from "@covel/shared";

/**
 * Structural type guard: identifies any value that has the minimum
 * MediaRef shape. Loose on purpose — plugin specs may carry extra
 * fields. The downstream resolver only needs id/mime/size to function.
 */
export function isMediaRef(value: unknown): value is MediaRef {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.mime === "string" &&
    v.mime.length > 0 &&
    typeof v.size === "number" &&
    Number.isFinite(v.size)
  );
}
