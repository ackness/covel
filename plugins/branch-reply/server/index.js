import { applyBranchReplyAcceptedCandidates } from "./history-transform.ts";

export default function (covel) {
  covel.provideExtension("prompt.history-transform@1", "accepted-branch", {
    async handler(input, ctx) {
      const turns = await ctx.pluginData.list("turns");
      return {
        messages: applyBranchReplyAcceptedCandidates(input.messages, turns),
      };
    },
  });
}
