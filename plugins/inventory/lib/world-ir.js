/**
 * Read this turn's player inventory changes from WorldIR.
 *
 * The bundled extractor writes every item gain, loss and equipment change as
 * an `inventory_change` event whose attributes name the item entity, the
 * holder and the operation. Only changes held by the player reach the bag;
 * events about other characters' belongings are ignored.
 */

const OPERATIONS = {
  gain: "add",
  lose: "remove",
  equip: "equip",
  unequip: "unequip",
};
/** Most changes one ledger call takes; the handler reports the overflow. */
export const MAX_CHANGES = 8;
const MAX_TAGS = 5;

/**
 * @param {unknown} worldIR  `contract:world-ir@1` value
 * @param {{ id: string, name: string } | undefined} player
 * @returns {Array<{ op: string, name: string, quantity?: number, description?: string, tags?: string[] }>}
 */
export function inventoryChangesFromWorldIR(worldIR, player) {
  if (!player || !worldIR || typeof worldIR !== "object") return [];
  const ir = /** @type {Record<string, any>} */ (worldIR);
  const entities = new Map(
    (Array.isArray(ir.entities) ? ir.entities : []).map((entity) => [
      entity.id,
      entity,
    ]),
  );
  const heldByPlayer = (id) =>
    id === player.id ||
    (entities.get(id)?.type === "character" &&
      entities.get(id)?.name === player.name);

  const changes = [];
  for (const event of Array.isArray(ir.events) ? ir.events : []) {
    if (event?.type !== "inventory_change") continue;
    const attributes = event.attributes ?? {};
    const op = Object.hasOwn(OPERATIONS, attributes.operation)
      ? OPERATIONS[attributes.operation]
      : undefined;
    const item = entities.get(attributes.item);
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!op || !name || !heldByPlayer(attributes.holder)) continue;
    const change = { op, name };
    if (op === "add" || op === "remove")
      change.quantity =
        Number.isInteger(attributes.quantity) && attributes.quantity > 0
          ? attributes.quantity
          : 1;
    if (op === "add" && typeof item.description === "string")
      change.description = item.description;
    const tags = item.attributes?.tags;
    if (op === "add" && Array.isArray(tags)) {
      const kept = tags.filter((tag) => typeof tag === "string" && tag);
      if (kept.length) change.tags = kept.slice(0, MAX_TAGS);
    }
    changes.push(change);
  }
  return changes;
}
