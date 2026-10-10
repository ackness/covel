import { applyBranchReplyAcceptedCandidates } from "./history-transform.ts";

export default function (covel) {
  covel.provideExtension("prompt.history-transform@1", "accepted-branch", {
    async handler(input, ctx) {
      const accepted = await ctx.pluginData.list("accepted");
      return {
        messages: applyBranchReplyAcceptedCandidates(input.messages, accepted),
      };
    },
  });
}
