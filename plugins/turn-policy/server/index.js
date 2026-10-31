import {
  TURN_POLICY_CONTRACT,
  turnPolicyInputSchema,
  turnPolicyOutputSchema,
} from "@covel/plugin-handlers-utils";
import { chooseActors } from "../lib/policies.js";

export default function (covel) {
  covel.registerService({
    name: "turn-policy",
    contract: TURN_POLICY_CONTRACT,
    modelFacing: false,
    description:
      "Choose present actors using this provider's mention, list, random, manual or director strategy setting.",
    input: turnPolicyInputSchema,
    output: turnPolicyOutputSchema,
    handler: (input, ctx) => chooseActors(input, ctx, covel.pluginId),
  });
}
