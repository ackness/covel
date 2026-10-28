import { resolveI18nText } from "@covel/plugin-handlers-utils";

/**
 * The world's character attributes, read from `ctx.world.characterSchema`.
 * Shared by the roller, which lists the check attributes for the narrative,
 * and the recorder, which shows the attribute a receipt names.
 *
 * @typedef {import("@covel/plugin-handlers-utils").ExtensionWorldModel} World
 * @typedef {import("@covel/plugin-handlers-utils").ExtensionAttributeDefinition} Attribute
 */

/** @param {World | undefined} world @returns {ReadonlyArray<Attribute>} */
function schemaAttributes(world) {
  const attributes = world?.characterSchema?.attributes;
  return Array.isArray(attributes) ? attributes : [];
}

/**
 * An attribute's name in the session's language. Names may be I18nText; the
 * schema carries no per-locale files.
 *
 * @param {Attribute} attribute
 * @param {string | undefined} locale
 */
export function attributeName(attribute, locale) {
  return (
    (attribute.name ? resolveI18nText(attribute.name, locale) : undefined) ?? ""
  );
}

/**
 * The check attributes: numbers in the `abilities` category with a declared
 * maximum above their minimum (0 when none is declared). These are the
 * attributes `tabletop-rules` offers for point buy and its check panel.
 * Health and other meters (`stats`) and relationships (`social`) are not
 * check attributes, so the narrative does not roll against them.
 *
 * @param {World | undefined} world
 */
export function checkAttributes(world) {
  return schemaAttributes(world).filter(
    (attr) =>
      attr.type === "number" &&
      attr.category === "abilities" &&
      typeof attr.max === "number" &&
      attr.max > (typeof attr.min === "number" ? attr.min : 0),
  );
}

/** @param {Attribute} attribute */
function namesOf(attribute) {
  const name = attribute.name;
  if (typeof name === "string") return [name];
  return name && typeof name === "object"
    ? Object.values(name).filter((text) => typeof text === "string")
    : [];
}

/**
 * How the check log shows the attribute a receipt names: the name of the
 * world's attribute that the receipt gives by id or by name, in the
 * session's language. Text that names no attribute of the world is shown
 * as written.
 *
 * @param {World | undefined} world
 * @param {string} reported
 * @param {string | undefined} locale
 */
export function attributeLabel(world, reported, locale) {
  const wanted = reported.toLowerCase();
  const attribute = schemaAttributes(world).find(
    (attr) =>
      (typeof attr.id === "string" && attr.id.toLowerCase() === wanted) ||
      namesOf(attr).some((name) => name.trim().toLowerCase() === wanted),
  );
  return (attribute && attributeName(attribute, locale)) || reported;
}
