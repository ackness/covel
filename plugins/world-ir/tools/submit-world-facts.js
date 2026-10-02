import { z } from "zod";
import { validateWorldIRV1, worldIRV1Schema } from "../schemas/world-ir.ts";
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
 * round trip for them: copied extraction input is dropped, a fact array sent
 * as a JSON string is parsed, and details written beside a fact's fields
 * move into its `attributes`, as the prompt asks. Anything else still fails
 * validation with its path.
 */
function normalizeArguments(value) {
  if (!isRecord(value)) return value;
  const facts = { ...value };
  for (const key of INPUT_KEYS) delete facts[key];
  for (const [kind, fields] of Object.entries(FACT_FIELDS)) {
    let list = facts[kind];
    if (typeof list === "string") {
      try {
        list = JSON.parse(list);
      } catch {
        continue;
      }
    }
    if (Array.isArray(list))
      facts[kind] = list.map((fact) => withDetailsInAttributes(fact, fields));
  }
  return facts;
}

/**
 * The prompt gives the model the session's characters and asks it to reuse
 * their ids. Referencing one without also listing it under `entities` is the
 * common slip, and rejecting it costs a whole extra model call. Declare such
 * characters from the session roster instead; any other undeclared id still
 * fails.
 */
function withKnownCharacters(facts, characters) {
  const declared = new Set(facts.entities.map((entity) => entity.id));
  const known = new Map(
    characters.map((character) => [character.id, character]),
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
      const completed = withKnownCharacters(
        facts,
        context?.world?.characters ?? [],
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
