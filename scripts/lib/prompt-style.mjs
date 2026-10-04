/**
 * Style checks for the English prompt bodies of plugins.
 *
 * A prompt body has a contract zone and a voice zone. The contract zone says
 * what the runtime reads, does and returns; a model must not misread it, so
 * it is written in controlled English. The voice zone, a section titled
 * `Voice`, holds tone, style and examples and is free prose.
 *
 * These checks read the contract zone only. They are warnings: a rule here
 * is a default, and a sentence can have a reason to break it.
 */

/** Sections whose text is free prose, by heading. */
const VOICE_HEADING = /^(voice|examples?)\b/i;

/**
 * Words the prompt vocabulary replaces (docs/glossary.md): one thing has one
 * name in every prompt body.
 */
const VOCABULARY = [
  [/\b(hero|protagonist)(es|s)?\b/gi, "player character"],
  [/\brounds?\b/gi, "turn"],
  [/\b(the |a )users?\b(?! (message|role|settings))/gi, "player"],
];

/** Words that leave the decision open without saying how to make it. */
const VAGUE =
  /\b(as appropriate|if appropriate|as needed|if needed|if necessary|as necessary|when appropriate|where appropriate|if possible|when possible|as much as possible|try to|feel free to|and so on|etc\.?)(?=\W|$)/gi;

/** An instruction about the language to write in. The framework adds it. */
const OUTPUT_LANGUAGE =
  /\b(respond|reply|answer|write|output|narrate|speak)\b[^.\n]{0,40}\bin (chinese|english|japanese|simplified chinese|the (?:same |user'?s |player'?s )?language( of [a-z ]+)?)\b|\b(in|use) (chinese|english|japanese) (only|always)\b/gi;

function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/`[^`\n]*`/g, "CODE");
}

/** Lines of the contract zone, with their line numbers in the body. */
function contractLines(body) {
  const lines = stripCode(body).split("\n");
  const kept = [];
  let voiceLevel = 0;
  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (voiceLevel && level <= voiceLevel) voiceLevel = 0;
      if (!voiceLevel && VOICE_HEADING.test(heading[2].trim()))
        voiceLevel = level;
      return;
    }
    if (!voiceLevel) kept.push({ number: index + 1, text: line });
  });
  return kept;
}

function words(text) {
  return text.match(/[A-Za-z0-9][A-Za-z0-9'’/-]*/g)?.length ?? 0;
}

/** Sentences of one block of prose: a paragraph, a list item, a table cell. */
function sentences(text) {
  return text
    .split(/(?<=[.!?:][*_"”)]{0,3})\s+(?=[A-Z"“(`*])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function shape(body) {
  const text = body.replace(/```[\s\S]*?```/g, "```\n```");
  return {
    headings: text.match(/^#{1,6} /gm)?.length ?? 0,
    "list items": text.match(/^\s*(?:[-*+]|\d+[.)]) /gm)?.length ?? 0,
    "table rows": text.match(/^\|/gm)?.length ?? 0,
    "code blocks": (text.match(/^```/gm)?.length ?? 0) / 2,
  };
}

/**
 * Where a translation's structure differs from the English body. A variant
 * is a translation, sentence for sentence: a section, a list item or a table
 * row in one language and not in the other is a rule that one language of
 * sessions does not get. The lock sees that a pair changed; it cannot see
 * that the two halves were never the same.
 *
 * @param {string} english
 * @param {string} translated
 * @returns {string[]}
 */
export function structureDifferences(english, translated) {
  const a = shape(english);
  const b = shape(translated);
  return Object.keys(a)
    .filter((key) => a[key] !== b[key])
    .map((key) => `${a[key]} ${key} in English, ${b[key]} in the variant`);
}

/**
 * @param {string} body English prompt body, without frontmatter
 * @returns {{ line: number, rule: string, message: string }[]}
 */
export function promptStyleFindings(body) {
  const findings = [];
  const add = (line, rule, message) => findings.push({ line, rule, message });
  const seen = new Map();

  for (const { number, text } of contractLines(body)) {
    const trimmed = text.trim();
    if (!trimmed || /^\|?[\s:|-]+\|?$/.test(trimmed)) continue;
    const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(text);
    // A table row is cells of data, not sentences of instruction.
    const prose = trimmed.startsWith("|")
      ? []
      : sentences(trimmed.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
    const limit = listItem ? 20 : 25;
    for (const sentence of prose) {
      const count = words(sentence);
      if (count > limit)
        add(
          number,
          "sentence-length",
          `${count} words in one ${listItem ? "step" : "sentence"} (at most ${limit}): "${sentence.slice(0, 60)}…"`,
        );
      // A rule stated twice gets changed in one place and not the other.
      // A line of identifiers is a list, not a rule.
      const key = sentence
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      if (words(sentence.replace(/\bCODE\b/g, "")) >= 6) {
        if (seen.has(key))
          add(
            number,
            "repeated",
            `the same sentence is on line ${seen.get(key)}: "${sentence.slice(0, 60)}…"`,
          );
        else seen.set(key, number);
      }
    }
    // Text in quotation marks is an example of what someone else wrote.
    const own = trimmed.replace(/"[^"\n]*"|“[^”\n]*”/g, "QUOTE");
    if (/\bshould(n't| not)?\b/i.test(own))
      add(number, "should", 'use "must", "must not" or "can", not "should"');
    for (const [pattern, term] of VOCABULARY)
      for (const match of own.matchAll(pattern))
        add(
          number,
          "term",
          `"${match[0]}": the prompt vocabulary says "${term}"`,
        );
    for (const match of trimmed.matchAll(VAGUE))
      add(number, "vague", `"${match[0]}" does not say how to decide`);
    for (const match of trimmed.matchAll(OUTPUT_LANGUAGE))
      add(
        number,
        "output-language",
        `"${match[0]}": the framework states the output language; a prompt must not`,
      );
  }
  return findings;
}
