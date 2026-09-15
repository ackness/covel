export async function record(ctx, kind) {
  const payload = ctx.manualPayload ?? {};
  const key = typeof payload.key === "string" ? payload.key : kind;
  const note = {
    kind,
    text: typeof payload.text === "string" ? payload.text : "Fixture record",
    label: ctx.userSettings?.label ?? "fixture",
    count: ctx.userSettings?.count ?? 1,
  };
  await ctx.pluginData.set("notes", key, note);
  // Deliberately fail after buffering a write to verify rollback boundaries.
  if (payload.fail === true) {
    return { outcome: "failed", error: "Synthetic fixture failure" };
  }
  return { outcome: "success", value: { key, note } };
}
