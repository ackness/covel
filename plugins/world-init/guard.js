import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { worldDimensionsSchema } from "@covel/plugin-handlers-utils/dimensions";

/** Adopt author declarations without deriving character attributes from global state. */
export default async function guard(ctx) {
  const existing = ctx.world.characterSchema;
  const world = ctx.world.worldRecord;
  const declared = world?.metadata?.characterSchema;
  const attributes = existing?.attributes ?? declared?.attributes;
  if (!attributes) return { skip: false, initialized: false };
  const definitions = worldDimensionsSchema.parse(
    world?.dimensions ?? world?.metadata?.dimensions ?? {},
  );
  const schema = {
    types: existing?.types ?? declared?.types ?? ["npc", "companion"],
    attributes,
  };
  const now = new Date().toISOString();
  const missingDefinitions = Object.fromEntries(
    Object.entries(definitions).filter(
      ([id]) => !Object.hasOwn(ctx.world.dimensions, id),
    ),
  );
  const proposals = [];
  if (Object.keys(missingDefinitions).length > 0)
    proposals.push(
      makeProposal(ctx, now, "dimension.initialize", {
        definitions: missingDefinitions,
      }),
    );
  if (!existing)
    proposals.unshift(makeProposal(ctx, now, "character.schema.set", schema));
  return withPendingProposals(
    {
      skip: true,
      success: true,
      preGameDone: true,
      attributeCount: attributes.length,
      dimensionCount: Object.keys(definitions).length,
      worldSchema: schema,
    },
    proposals,
  );
}
