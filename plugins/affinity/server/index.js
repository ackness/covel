import makeUpdateAffinity from "../tools/update-affinity.js";
import { currentAffinity } from "./current-affinity.js";

export default function (covel) {
  covel.registerTool(makeUpdateAffinity(covel.toolkit));
  covel.provideExtension("prompt.segment@1", "current-affinity", {
    handler: currentAffinity,
  });
}
