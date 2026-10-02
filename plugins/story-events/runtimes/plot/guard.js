/**
 * Decide whether the planner calls the model this turn. A skip answers with
 * an empty `story-event.plan@1`, which `intake` accepts as "nothing planned".
 */
export default async function guard(ctx) {
  if (ctx.recursionDepth > 0)
    return emptyPlan("The outer narrative execution owns story planning.");
  if (ctx.userSettings?.planner !== true)
    return emptyPlan("The story planner is turned off.");
  return { skip: false };
}

function emptyPlan(reason) {
  return { skip: true, events: [], reason };
}
