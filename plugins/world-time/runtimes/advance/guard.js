export default async function guard(ctx) {
  return {
    skip: ctx.recursionDepth > 0,
    reason: "The outer narrative execution owns world-time settlement.",
  };
}
