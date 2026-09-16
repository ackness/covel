/** Tracking changes must not rewrite a character's authored identity/profile. */
export default function protectCharacterProfiles(ctx, payload) {
  if (
    ctx.runtimeId !== "char-creator/character-tracker" ||
    payload.toolCall.name !== "sync-characters"
  ) {
    return { action: "continue" };
  }
  let args;
  try {
    args = JSON.parse(payload.toolCall.arguments);
  } catch {
    return { action: "continue" };
  }
  if (!Array.isArray(args?.updates)) return { action: "continue" };
  if (
    args.updates.some(
      (update) =>
        update &&
        typeof update === "object" &&
        ["name", "type", "description"].some((key) => key in update),
    )
  ) {
    return {
      action: "abort",
      reason:
        "Character tracking may only patch id and fields on existing characters. Keep their name, type and description unchanged; dialogue or a recollection is not a new biography. Submit explicit state changes in fields, or runtime-done when nothing changed.",
    };
  }
  return { action: "continue" };
}
