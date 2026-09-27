export async function record(ctx, kind) {
  const payload = ctx.manualPayload ?? {};
  const key = typeof payload.key === "string" ? payload.key : kind;
  const note = {
    kind,
    text: typeof payload.text === "string" ? payload.text : "Fixture record",
    label: ctx.userSettings?.label ?? "fixture",
    count: ctx.userSettings?.count ?? 1,
  };
  if (payload.providerPluginId !== undefined) {
    if (
      typeof payload.providerPluginId !== "string" ||
      payload.providerPluginId.length === 0
    ) {
      throw new Error("providerPluginId must be a nonempty plugin ID");
    }
    const contract = "probe/note-format@1";
    const provider = (await ctx.services.discover(contract)).find(
      (service) =>
        service.pluginId === payload.providerPluginId &&
        service.name === "format-note",
    );
    if (!provider) throw new Error("Requested note formatter is unavailable");
    const formatted = await ctx.services.call(
      {
        pluginId: provider.pluginId,
        name: provider.name,
        contract,
        input: { text: note.text },
      },
      { timeoutMs: 1500 },
    );
    note.text = formatted.text;
  }
  await ctx.pluginData.set("notes", key, note);
  // Deliberately fail after buffering a write to verify rollback boundaries.
  if (payload.fail === true) {
    return { outcome: "failed", error: "Synthetic fixture failure" };
  }
  return { outcome: "success", value: { key, note } };
}
