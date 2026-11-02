import type { ReviewAgentOutputPayload } from "./plugin-api.js";
import { instructionLocaleFor } from "./instruction-locale.js";

interface ReviewMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content:
    | string
    | readonly (
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "image" | "media" }
      )[];
}
/** The `perspective` setting of a narrator that uses this review. */
export type NarrativePerspective =
  | "character-first"
  | "character-second"
  | "character-third"
  | "omniscient"
  | "dm";
type Person = "first" | "second" | "third" | "omniscient";
type SettingsContext = {
  getOwnSettings?: () => Readonly<Record<string, unknown>>;
  sessionId?: string;
  turnId?: string;
  locale?: string;
  pluginId?: string;
  runtimeId?: string;
};
type Request = { messages: readonly ReviewMessage[] };
const perspectives: Record<
  NarrativePerspective,
  { readonly zh: string; readonly en: string }
> = {
  "character-first": {
    zh: "旁白用玩家角色的第一人称‘我/我的’，不是助手或作者的‘我’。例如：她望着我，雾灯照亮她的袖口。",
    en: "Narrate as the player character in first person (I/me/my), never as the assistant or author. Example: She looks at me; lamplight falls on her sleeve.",
  },
  "character-second": {
    zh: "旁白用玩家角色的第二人称‘你/你的’。例如：她望着你，雾灯照亮她的袖口。",
    en: "Refer to the player character in second person (you/your). Example: She looks at you; lamplight falls on her sleeve.",
  },
  "character-third": {
    zh: "旁白用玩家角色名及第三人称代词，保持玩家角色的有限视角，不称玩家为‘我’或‘你’。",
    en: "Refer to the player by character name and third-person pronouns, from that character's limited viewpoint. Do not address the player as I or you.",
  },
  omniscient: {
    zh: "旁白是全知的第三人称叙述者：用角色名和第三人称代词称呼每个人物，包括玩家角色；旁白里不出现‘我’或‘你’。",
    en: "Narrate as an omniscient third-person narrator. Refer to every character, the player character included, by name and third-person pronouns; narration never uses I or you.",
  },
  dm: {
    zh: "以主持人（DM）的口吻向玩家讲述：可以用‘你/你们’称呼玩家，描述场景和非玩家角色的反应，不替玩家做决定。",
    en: "Narrate as the game master speaking to the players at the table: you may address them as you, describe the scene and the non-player characters' reactions, and never decide for the players.",
  },
};

const PERSPECTIVES = Object.keys(perspectives) as NarrativePerspective[];

function perspectiveFor(ctx: SettingsContext): NarrativePerspective {
  const value = ctx.getOwnSettings?.().perspective;
  return (
    PERSPECTIVES.find((perspective) => perspective === value) ??
    "character-second"
  );
}

/** The pronoun rule a perspective imposes on narration; none for a DM. */
const personOf: Record<NarrativePerspective, Person | undefined> = {
  "character-first": "first",
  "character-second": "second",
  "character-third": "third",
  omniscient: "omniscient",
  dm: undefined,
};

const QUOTE_PAIRS: Record<string, string> = {
  "“": "”",
  "‘": "’",
  "「": "」",
  "『": "』",
  "«": "»",
  '"': '"',
  "'": "'",
};

/**
 * A letter of a script that writes apostrophes. Han, kana and Hangul do
 * not, so a ’ between two of them (‘我的船’吗) closes a quote.
 */
const isLetter = (char: string | undefined): boolean =>
  /\p{L}/u.test(char ?? "") &&
  !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    char ?? "",
  );

/**
 * Splits narration from quoted speech. `opened` tells whether any quotation
 * opened, so a text whose only marks are apostrophes has no speech in it.
 *
 * A single quote mark (`'` or `’`) is an apostrophe unless it delimits:
 * between letters (I'm, don’t, Aya's) it never does. Inside its matching
 * single quote, a mark after a letter and before whitespace plus a letter
 * may be a possessive (the guards' keys), so it stays inside speech. A mark
 * after dialogue punctuation still closes the quote. A straight `'` opens
 * a quote only when no letter precedes it.
 */
function scanDialogue(text: string): {
  narration: string;
  opened: boolean;
  /** Index of the first opening quote mark. */
  firstOpen?: number;
  /** Index of the mark that closes the first outermost quotation. */
  firstClose?: number;
} {
  const stack: { closer: string; start: number; ambiguous: boolean }[] = [];
  let result = "";
  let opened = false;
  let firstOpen: number | undefined;
  let firstClose: number | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const quote = stack.at(-1);
    const single = char === "'" || char === "’";
    const afterLetter = single && isLetter(text[i - 1]);
    let next = i + 1;
    if (afterLetter && char === quote?.closer) {
      // Each lookahead crosses only the adjacent whitespace run, keeping
      // the total scan linear even with many ambiguous marks.
      while (next < text.length && /\s/u.test(text[next]!)) next++;
      if (next > i + 1 && isLetter(text[next])) quote.ambiguous = true;
    }
    const apostrophe = afterLetter && isLetter(text[next]);
    if (!apostrophe && char === quote?.closer) {
      stack.pop();
      if (!stack.length) firstClose ??= i;
      result += " ";
    } else if (
      !apostrophe &&
      QUOTE_PAIRS[char] &&
      (char !== "'" || !isLetter(text[i - 1]))
    ) {
      stack.push({ closer: QUOTE_PAIRS[char]!, start: i, ambiguous: false });
      opened = true;
      firstOpen ??= i;
    } else if (!stack.length) result += char;
  }
  // Validate an unclosed tail without un-hiding earlier closed dialogue.
  // If an unmatched quotation has a possessive/closing ambiguity, keep its
  // words hidden; that ambiguity alone must not request a perspective repair.
  // An unambiguous outer tail before a nested ambiguous quote is still checked.
  const openStart = stack[0]?.start;
  const ambiguousStart = stack.find((quote) => quote.ambiguous)?.start;
  return {
    narration:
      openStart === undefined
        ? result
        : result + text.slice(openStart, ambiguousStart ?? text.length),
    opened,
    ...(firstOpen !== undefined ? { firstOpen } : {}),
    ...(firstClose !== undefined ? { firstClose } : {}),
  };
}

/**
 * Whether a `dialogue` segment carries narration beside its quotes. A segment
 * that names its speaker holds that speaker's words, so text that starts
 * unquoted is speech and any quote marks inside it quote someone within that
 * speech (学生会说只是『暂存』, They called it "temporary storage").
 *
 * Narration is assumed when the segment is shaped like a quote with narration
 * around it: it opens with the quotation (「走吧。」我说。, "I'm ready," I say.),
 * or a lead-in introduces a quotation with a colon (我说：「走吧。」) or with a
 * comma when the quotation then ends the segment (I say, "Let's go."). Without
 * a speaker, any quotation means the text outside it is narration.
 */
function dialogueHasNarration(text: string, speaker: unknown): boolean {
  const scan = scanDialogue(text);
  if (!scan.opened || scan.firstOpen === undefined) return false;
  const lead = text.slice(0, scan.firstOpen).trim();
  if (!lead || typeof speaker !== "string" || !speaker.trim()) return true;
  if (/[:：]$/u.test(lead)) return true;
  return (
    /[,，]$/u.test(lead) &&
    scan.firstClose !== undefined &&
    /^[\s\p{P}]*$/u.test(text.slice(scan.firstClose + 1))
  );
}

/** Inspect narration without changing dialogue or the original story text. */
export function outsideDialogue(text: string): string {
  return scanDialogue(text).narration;
}

const personNames = {
  first: { zh: "第一人称", en: "first-person" },
  second: { zh: "第二人称", en: "second-person" },
  third: { zh: "第三人称", en: "third-person" },
  omniscient: { zh: "全知第三人称", en: "omniscient third-person" },
} as const;

/**
 * Whether the session reads the Chinese prompt body. Every text this review
 * adds to the request is in the language of that body.
 */
const readsChinese = (ctx: SettingsContext): boolean =>
  instructionLocaleFor(ctx.locale) === "zh";

/**
 * Where narration in `text` breaks the perspective's pronoun rule, as a
 * correction for the model; undefined when it keeps the rule. Quoted speech
 * is never checked. A `dm` perspective has no pronoun rule.
 */
export function perspectiveError(
  text: string,
  perspective: NarrativePerspective,
  language: "zh" | "en" = "en",
): string | undefined {
  const person = personOf[perspective];
  if (!person) return undefined;
  const narration = outsideDialogue(text).replace(
    /自我|忘我|无我|你来我往|尔虞我诈|迷你/g,
    "",
  );
  const forbidden =
    person === "first"
      ? /[你妳您]|\b(?:you|your|yours|yourself|yourselves)\b/iu
      : person === "third" || person === "omniscient"
        ? /[我你妳您]|\b(?:I|me|my|mine|myself|we|us|our|ours|you|your|yours)\b/iu
        : /我|\b(?:I|me|my|mine|myself)\b/iu;
  const match = narration.match(forbidden);
  if (!match) return undefined;
  const start = Math.max(0, (match.index ?? 0) - 18);
  const near = narration.slice(start, start + 65);
  return language === "zh"
    ? `旁白在这里违反了${personNames[person].zh}视角：${near}。只改旁白；引号里说话者的人称保持不变。`
    : `Narration violates ${personNames[person].en} perspective near: ${near}. Fix narration only; keep quoted speakers' pronouns.`;
}

/** Read validated output directly; dialogue speech is checked by dialogueHasNarration. */
function outputTexts(output: ReviewAgentOutputPayload["output"]) {
  if (Array.isArray(output.segments)) {
    return output.segments.flatMap((segment: unknown) => {
      if (!segment || typeof segment !== "object") return [];
      const { kind, speaker, text } = segment as {
        kind?: unknown;
        speaker?: unknown;
        text?: unknown;
      };
      return typeof text === "string" ? [{ kind, speaker, text }] : [];
    });
  }
  return typeof output.narrativeOutput === "string"
    ? [{ kind: "narration", speaker: undefined, text: output.narrativeOutput }]
    : [];
}

/** Plugin-owned policy using the same public hooks available to community packages. */
export function createNarrativeReview(pluginId: string) {
  const players = new Map<string, string>();
  const keyFor = (ctx: SettingsContext) =>
    `${ctx.sessionId}\0${ctx.turnId}\0${ctx.runtimeId}`;
  return {
    context(
      ctx: SettingsContext,
      payload: {
        characters?: readonly { id?: string; name: string; type: string }[];
        /** The character the player acts as (the primary seat's). */
        currentCharacterId?: string;
      },
    ) {
      if (ctx.pluginId === pluginId && payload.currentCharacterId) {
        const player = payload.characters?.find(
          (character) => character.id === payload.currentCharacterId,
        );
        if (player) players.set(keyFor(ctx), player.name);
      }
      return { action: "continue" as const };
    },
    cleanup(ctx: SettingsContext) {
      const prefix = `${ctx.sessionId}\0${ctx.turnId}\0`;
      for (const key of players.keys())
        if (key.startsWith(prefix)) players.delete(key);
      return { action: "continue" as const };
    },
    prepare(ctx: SettingsContext, payload: Request) {
      if (ctx.pluginId !== pluginId) return { action: "continue" as const };
      const zh = readsChinese(ctx);
      const perspective = perspectiveFor(ctx);
      // An omniscient narrator follows no one character.
      const player =
        perspective === "omniscient" ? undefined : players.get(keyFor(ctx));
      const playerLine = !player
        ? ""
        : zh
          ? `玩家角色：${JSON.stringify(player)}。`
          : `Player character: ${JSON.stringify(player)}. `;
      const instruction =
        playerLine +
        perspectives[perspective][zh ? "zh" : "en"] +
        (zh
          ? " 人物直接对白保留说话者人称。不要复述玩家输入、替玩家添加行动或内心想法。查询工具时只调用工具，不输出准备说明；工具返回后用 `submit-output` 提交场景，不写核对档案或写作过程。"
          : " Quoted dialogue keeps each speaker's perspective. Do not restate the player's input or add player actions/thoughts. During lookups call tools without preparation chatter; afterward submit the scene through `submit-output`, with no lookup or writing commentary.");
      return {
        action: "continue" as const,
        replace: {
          messages: [
            ...payload.messages,
            { role: "system" as const, content: instruction },
          ],
        },
      };
    },
    review(ctx: SettingsContext, payload: ReviewAgentOutputPayload) {
      if (ctx.pluginId !== pluginId) return { action: "continue" as const };
      const texts = outputTexts(payload.output);
      const zh = readsChinese(ctx);
      const perspective = perspectiveFor(ctx);
      const correction =
        payload.correction ||
        (!texts.some(({ text }) => text.trim())
          ? zh
            ? "请用 `submit-output` 提交本回合完整的故事正文。"
            : "Submit the complete story of this turn through `submit-output`."
          : texts.some(({ text }) =>
                /<\/?(?:system|system_warning|analysis|thinking|runtime-inputs|available-events)\b/i.test(
                  text,
                ),
              )
            ? zh
              ? "只输出游戏内的故事正文。去掉内部指令标签和说明文字。"
              : "Output only the in-world story. Remove internal instruction tags and commentary."
            : texts
                .flatMap(({ kind, speaker, text }) =>
                  kind === "dialogue" && !dialogueHasNarration(text, speaker)
                    ? []
                    : [perspectiveError(text, perspective, zh ? "zh" : "en")],
                )
                .find(Boolean));
      return correction
        ? { action: "continue" as const, replace: { correction } }
        : { action: "continue" as const };
    },
  };
}
