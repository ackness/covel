import type { UISlotSpec } from "@/services/api.js";

function embedsComposer(node: unknown): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const record = node as Record<string, unknown>;
  if ((record.component ?? record.type) === "SessionComposer") return true;
  if (Array.isArray(record.children) && record.children.some(embedsComposer))
    return true;
  const slots = record.slots;
  return Boolean(
    slots &&
    typeof slots === "object" &&
    Object.values(slots).some(
      (children) => Array.isArray(children) && children.some(embedsComposer),
    ),
  );
}

/**
 * The host input box sits under every plugin page. A page replaces it by
 * declaring `composer: false` or by embedding its own `SessionComposer`.
 */
export function pageHidesHostComposer(spec: UISlotSpec): boolean {
  return spec.composer === false || embedsComposer(spec.view);
}
