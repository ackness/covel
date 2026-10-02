export default async function guard(ctx) {
  if (ctx.recursionDepth > 0) {
    return {
      skip: true,
      reason: "The outer narrative execution owns story planning.",
    };
  }
  if (ctx.userSettings?.planner !== true) {
    return { skip: true, reason: "The story planner is turned off." };
  }
  return { skip: false };
}
