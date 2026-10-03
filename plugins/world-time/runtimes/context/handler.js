import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";

import { loadTime } from "../../clock.js";

export default async function handler(ctx) {
  const current = await loadTime(ctx.store, ctx.locale, ctx);
  if (ctx.recursionDepth > 0) return { outcome: "success", value: current };
  // Initialization and locale refresh share the story transaction, never a live write.
  return withPendingProposals({ outcome: "success", value: current }, [
    makeProposal(ctx, new Date().toISOString(), "plugin.data", {
      namespace: "clock",
      key: "current",
      value: current,
    }),
  ]);
}
