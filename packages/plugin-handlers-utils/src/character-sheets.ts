import type {
  ExtensionWorldCharacter,
  PromptSegment,
} from "./extension-points.js";
import { modelFacingJson } from "./model-facing.js";
import { pickLocaleText } from "./locale-text.js";

const PROFILES_BUDGET = 8000;
const PROFILE_PART_CAP = 400;

const capped = (text: string) =>
  text.length > PROFILE_PART_CAP
    ? `${text.slice(0, PROFILE_PART_CAP)}...`
    : text;

/** Content between tags must not be able to close its own tag. */
const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const hasFields = (fields: unknown): fields is Record<string, unknown> =>
  fields !== null &&
  typeof fields === "object" &&
  Object.keys(fields).length > 0;

/**
 * One line per non-player character: `- name [type] | description | fields`.
 * Past the budget the rest are listed by name only, to be looked up when
 * needed. No ids: a model looks characters up by name. The format of the
 * `{{ characters.npcs }}` template variable.
 */
function profileLines(
  characters: readonly ExtensionWorldCharacter[],
  locale: string | undefined,
): string {
  const lines: string[] = [];
  const unlisted: string[] = [];
  let used = 0;
  for (const character of characters) {
    if (character.type === "player") continue;
    const parts = [`- ${character.name} [${character.type}]`];
    if (character.description) parts.push(capped(character.description));
    if (hasFields(character.fields))
      parts.push(capped(JSON.stringify(modelFacingJson(character.fields))));
    const line = parts.join(" | ");
    if (unlisted.length > 0 || used + line.length > PROFILES_BUDGET) {
      unlisted.push(character.name);
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (unlisted.length > 0)
    lines.push(
      pickLocaleText(
        locale,
        `- （未列出档案：${unlisted.join("、")}）`,
        `- (profiles not shown: ${unlisted.join(", ")})`,
      ),
    );
  return lines.join("\n");
}

/**
 * The characters of the session as a turn-volatile prompt segment: the
 * player's sheet in `<player-character>` and, with `profiles`, one line per
 * non-player character in `<character-profiles>`.
 *
 * A prompt body can interpolate the same data with `{{ player.character }}`
 * and `{{ characters.npcs }}`, but then the system prompt changes whenever a
 * character does, and a provider's prefix cache stops there: every turn, in
 * a session that tracks wounds or conditions. A turn-volatile segment is
 * placed after the history instead, so the body stays as written. Name the
 * blocks in the body, and return this from a `prompt.segment@1` provider:
 *
 * ```js
 * covel.provideExtension("prompt.segment@1", "cast", {
 *   handler: (_input, ctx) => characterSheetSegments(ctx.world.characters),
 * });
 * ```
 *
 * Returns no segment when the session has no character to show. Pass
 * `ctx.locale` as `locale`: the one sentence this writes (the names of the
 * profiles left out) is then in the language of the prompt body.
 */
export function characterSheetSegments(
  characters: readonly ExtensionWorldCharacter[],
  options: { readonly profiles?: boolean; readonly locale?: string } = {},
): PromptSegment[] {
  const blocks: string[] = [];
  const player = characters.find((character) => character.type === "player");
  if (player) {
    const { id, name, type, description, fields } = player;
    const sheet = JSON.stringify(
      modelFacingJson({ id, name, type, description, fields }),
      null,
      2,
    );
    blocks.push(`<player-character>\n${escapeXml(sheet)}\n</player-character>`);
  }
  const profiles = options.profiles
    ? profileLines(characters, options.locale)
    : "";
  if (profiles)
    blocks.push(
      `<character-profiles>\n${escapeXml(profiles)}\n</character-profiles>`,
    );
  if (blocks.length === 0) return [];
  return [
    {
      id: "character-sheets",
      content: blocks.join("\n"),
      position: "system",
      audience: "self",
      volatility: "turn",
    },
  ];
}
