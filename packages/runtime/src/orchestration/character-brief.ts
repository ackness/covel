import { loadPrompt } from "@covel/context";
import {
  modelFacingJson,
  type CharacterHistory,
  type WorldModelView,
} from "@covel/shared";

/** Only the selected public profile and witnessed stories accompany the caller's prose. */
export async function buildCharacterBrief(
  character: WorldModelView["characters"][number],
  history: CharacterHistory,
  brief: string,
  instruction?: string,
  locale?: string,
): Promise<string> {
  const frame = await loadPrompt("server", "character-brief", locale);
  // Keep complete field values. Profiles are untrusted data and can themselves
  // exceed the context allowance, even when no history is included.
  const profile = {
    name: character.name,
    aliases: character.aliases ? [...character.aliases] : undefined,
    description: character.description,
    fields: modelFacingJson(character.fields ?? {}),
  };
  const profileSize = () => JSON.stringify(profile).length;
  if (
    profile.fields &&
    typeof profile.fields === "object" &&
    !Array.isArray(profile.fields)
  ) {
    for (const key of Object.keys(profile.fields).reverse()) {
      if (profileSize() <= 10_000) break;
      delete (profile.fields as Record<string, unknown>)[key];
    }
  } else if (profileSize() > 10_000) profile.fields = {};
  while (profile.aliases?.length && profileSize() > 10_000)
    profile.aliases.pop();
  if (profileSize() > 10_000)
    profile.description = Array.from(profile.description ?? "")
      .slice(0, 2_000)
      .join("");
  if (profileSize() > 10_000)
    profile.name = Array.from(profile.name).slice(0, 80).join("");
  const messages = [...history.messages];
  const render = () =>
    `${frame}\n\n${JSON.stringify({ profile, history: { ...history, truncated: history.truncated || messages.length < history.messages.length, messages } })}\n\n<caller-brief>\n${brief}\n</caller-brief>${instruction !== undefined ? `\n\n<caller-instruction>\n${instruction}\n</caller-instruction>` : ""}`;
  while (messages.length && render().length > 40_000) messages.shift();
  return render();
}
