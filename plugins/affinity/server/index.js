import makeUpdateAffinity from "../tools/update-affinity.js";
import { currentAffinity } from "./current-affinity.js";
import { affinityTiers, TIER_ORDER } from "./tier-service.js";

export default function (covel) {
  const { z } = covel.toolkit;
  covel.registerTool(makeUpdateAffinity(covel.toolkit));
  covel.provideExtension("prompt.segment@1", "current-affinity", {
    handler: currentAffinity,
  });
  covel.registerService({
    name: "tiers",
    contract: "affinity.tier@1",
    description:
      "Read each NPC's committed affinity with the player: score from -100 to 100 and its tier. `tiers` lists the tier ids from the lowest to the highest. Optionally narrow to one character by name.",
    input: z.object({ name: z.string().max(80).optional() }),
    output: z.object({
      tiers: z.array(z.enum(TIER_ORDER)),
      characters: z.array(
        z.object({
          name: z.string(),
          score: z.number().int(),
          tier: z.enum(TIER_ORDER),
          label: z.string(),
        }),
      ),
    }),
    handler: affinityTiers,
  });
}
