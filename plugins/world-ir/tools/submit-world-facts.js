import { validateWorldIRV1, worldIRV1Schema } from "../schemas/world-ir.ts";
import { eventProfileIssues } from "./event-profiles.js";

const MAX_ENTITIES = 32;

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
  const parameters = worldIRV1Schema
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
