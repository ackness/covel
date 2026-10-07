import {
  makeProposal,
  withPendingProposals,
  translate,
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
  const proposals = [
    makeProposal(ctx, now, "dimension.initialize", { definitions }),
  ];
  if (!existing)
    proposals.unshift(makeProposal(ctx, now, "character.schema.set", schema));
  return withPendingProposals(
    {
      skip: true,
      initialized: true,
      preGameDone: true,
      schemaCount: attributes.length,
      dimensionCount: Object.keys(definitions).length,
      worldSchema: schema,
      narrativeOutput: translate(ctx, "[System] World data loaded"),
    },
    proposals,
  );
}
