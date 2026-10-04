import { z } from "zod";
import { validateWorldIRV1, worldIRV1Schema } from "../schemas/world-ir.ts";
import { characterHandles } from "./character-handles.js";
import { eventProfileIssues } from "./event-profiles.js";

const MAX_ENTITIES = 32;
// Keys of the extraction input (see server/extraction-context.js); they are
// never facts.
const INPUT_KEYS = ["narrative", "characters", "vocabulary"];
// Top-level fields of each fact kind; anything else is a detail.
const FACT_FIELDS = {
  entities: ["id", "type", "name", "description", "attributes"],
  relations: ["id", "type", "from", "to", "description", "attributes"],
  events: ["id", "type", "participantIds", "time", "description", "attributes"],
  statements: ["id", "type", "content", "subjectIds", "attributes"],
};

function validationPath(path) {
  if (path === "(root)") return [];
  return path.split(".").map((part) => {
    const index = Number(part);
    return Number.isInteger(index) && String(index) === part ? index : part;
  });
}

/** Ids that relations, events, and statements point at. */
function referencedIds(facts) {
  return [
    ...facts.relations.flatMap((relation) => [relation.from, relation.to]),
    ...facts.events.flatMap((event) => event.participantIds ?? []),
    ...facts.statements.flatMap((statement) => statement.subjectIds ?? []),
  ];
}

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Move details placed beside a fact's fields into its `attributes`. */
function withDetailsInAttributes(fact, fields) {
  if (!isRecord(fact)) return fact;
  const extra = Object.keys(fact).filter((key) => !fields.includes(key));
  if (
    !extra.length ||
    (fact.attributes !== undefined && !isRecord(fact.attributes))
  )
    return fact;
  const normalized = { attributes: { ...fact.attributes } };
  for (const [key, value] of Object.entries(fact)) {
    if (key === "attributes") continue;
    if (fields.includes(key)) normalized[key] = value;
    else normalized.attributes[key] = value;
  }
  return normalized;
}

/**
 * Repair mechanical slips before validation instead of paying a model
 * round trip for them: copied extraction input is dropped, and details
 * written beside a fact's fields move into its `attributes`, as the prompt
 * asks. (`tool()` already parses a fact array sent as JSON text.) Anything
 * else still fails validation with its path.
 */
function normalizeArguments(value) {
  if (!isRecord(value)) return value;
  const facts = { ...value };
  for (const key of INPUT_KEYS) delete facts[key];
  for (const [kind, fields] of Object.entries(FACT_FIELDS)) {
    if (Array.isArray(facts[kind]))
      facts[kind] = facts[kind].map((fact) =>
        withDetailsInAttributes(fact, fields),
      );
  }
  return withInventoryItems(facts);
}

/**
 * An inventory change names its item. The model often names the item there
 * and does not list it under `entities` again, or writes the item's name
 * where its id goes. In real-model runs this was the most frequent reason
 * for a rejected output, and each rejection costs the whole extraction a
 * second time. Both forms say which item is meant, so they are settled here:
 * a name becomes the id of the item that has it, and an item that is not
 * listed is listed. An id that belongs to an entity of another type is left
 * alone: that is a contradiction, and validation reports it.
 */
function withInventoryItems(facts) {
  if (!Array.isArray(facts.events)) return facts;
  const entities = Array.isArray(facts.entities) ? [...facts.entities] : [];
  const ids = new Set(entities.filter(isRecord).map((entity) => entity.id));
  const itemIdByName = new Map(
    entities
      .filter(
        (entity) =>
          isRecord(entity) &&
          entity.type === "item" &&
          typeof entity.name === "string",
      )
      .map((entity) => [entity.name, entity.id]),
  );
  let changed = false;
  const events = facts.events.map((event) => {
    const item =
      isRecord(event) &&
      event.type === "inventory_change" &&
      isRecord(event.attributes)
        ? event.attributes.item
        : undefined;
    if (typeof item !== "string" || !item || ids.has(item)) return event;
    changed = true;
    const named = itemIdByName.get(item);
    if (named !== undefined)
      return { ...event, attributes: { ...event.attributes, item: named } };
    if (entities.length >= MAX_ENTITIES) return event;
    entities.push({ id: item, type: "item", name: item });
    ids.add(item);
    itemIdByName.set(item, item);
    return event;
  });
  return changed ? { ...facts, entities, events } : facts;
}

/**
 * The model names session characters by their word handles; restore the real
 * ids wherever an id is expected, including an inventory change's holder.
 */
function withCharacterIds(facts, handles) {
  const real = (id) => handles.get(id)?.id ?? id;
  const realAll = (ids) => ids && ids.map(real);
  return {
    ...facts,
    entities: facts.entities.map((entity) => ({
      ...entity,
      id: real(entity.id),
    })),
    relations: facts.relations.map((relation) => ({
      ...relation,
      from: real(relation.from),
      to: real(relation.to),
    })),
    events: facts.events.map((event) => {
      const restored = { ...event };
      if (event.participantIds)
        restored.participantIds = realAll(event.participantIds);
      if (
        event.type === "inventory_change" &&
        typeof event.attributes?.holder === "string"
      )
        restored.attributes = {
          ...event.attributes,
          holder: real(event.attributes.holder),
        };
      return restored;
    }),
    statements: facts.statements.map((statement) =>
      statement.subjectIds
        ? { ...statement, subjectIds: realAll(statement.subjectIds) }
        : statement,
    ),
  };
}

/**
 * The prompt asks the model to reference session characters without listing
 * them under `entities`, which keeps the output short. Declare them from the
 * session roster; any other undeclared id still fails.
 */
function withKnownCharacters(facts, handles) {
  const declared = new Set(facts.entities.map((entity) => entity.id));
  const known = new Map(
    [...handles.values()].map((character) => [character.id, character]),
  );
  const added = [];
  for (const id of referencedIds(facts)) {
    const character = known.get(id);
    if (declared.has(id) || !character) continue;
    declared.add(id);
    added.push({ id, type: "character", name: character.name });
  }
  const room = Math.max(0, MAX_ENTITIES - facts.entities.length);
  return added.length
    ? { ...facts, entities: [...facts.entities, ...added.slice(0, room)] }
    : facts;
}

export default function ({ tool }) {
  const facts = worldIRV1Schema
    .extend({
      schemaVersion: worldIRV1Schema.shape.schemaVersion.default(1),
    })
    .superRefine((value, ctx) => {
      const validation = validateWorldIRV1(value);
      // Undeclared references are settled in `execute`, where the session
      // roster is available.
      const blocking = validation.valid
        ? []
        : validation.errors.filter(
            (error) => error.code !== "dangling_reference",
          );
      if (blocking.length) {
        for (const error of blocking) {
          ctx.addIssue({
            code: "custom",
            path: validationPath(error.path),
            message: error.message,
          });
        }
        return;
      }
      for (const issue of eventProfileIssues(value))
        ctx.addIssue({ code: "custom", ...issue });
    });
  const parameters = z.preprocess(normalizeArguments, facts);

  return tool({
    name: "submit-world-facts",
    description:
      "Submit the people, relationships, events, and explicit knowledge extracted from this story turn. The arguments become the complete World IR output; put non-contract details inside attributes.",
    parameters,
    execute: async (facts, context) => {
      const handles = characterHandles(context?.world?.characters ?? []);
      const completed = withKnownCharacters(
        withCharacterIds(facts, handles),
        handles,
      );
      const validation = validateWorldIRV1(completed);
      if (validation.valid) return completed;
      const details = validation.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; ");
      throw new Error(
        `Invalid parameters for tool "submit-world-facts": ${details}. Declare every referenced id in entities and retry.`,
      );
    },
  });
}
