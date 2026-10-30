import { fillNarrativeTemplate, ToolError } from "@covel/plugin-handlers-utils";

// Whole-value matches only: an undecided voter or a story about an unknown
// parent is a valid character detail. Schema enum values are author choices.
const UNDECIDED = {
  en: /^(?:undecided|not yet decided|to be decided|tbd)$/i,
  zh: /^(?:待定|未定|尚未定下|尚未决定)$/u,
};
const UNDECIDED_CALLING = {
  en: /^(?:an? )?(?:undecided|not yet decided) adventurer$/i,
  zh: /^(?:待定|未定|尚未定下|尚未决定)的冒险者$/u,
};

export function defaultNarrative(form) {
  return fillNarrativeTemplate(
    form.narrativeTemplate ?? "",
    Object.fromEntries(
      form.fields.map((field) => [
        field.name,
        // Submission treats a blank optional answer as missing.
        typeof field.defaultValue === "string" && !field.defaultValue.trim()
          ? undefined
          : field.defaultValue,
      ]),
    ),
  );
}

/** Compare only adjacent words, never substrings elsewhere in a background. */
function boundaryWord(segmenter, text, edge) {
  const trimmed = text.trim();
  const words = [...segmenter.segment(trimmed)];
  const word = edge === "start" ? words[0] : words.at(-1);
  return word?.isWordLike && [...word.segment].length >= 2
    ? word.segment.toLowerCase()
    : undefined;
}

/** Checks model defaults, not the player's answers when a form is reoffered. */
export function checkFormDefaults(form, attributes, locale = "en") {
  const language = new Intl.Locale(locale).language;
  const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
  const issues = [];
  const matches = Array.from(
    (form.narrativeTemplate ?? "").matchAll(/\{\{([^{}]+)\}\}/g),
  );
  const placeholders = new Set(matches.map((match) => match[1].trim()));
  for (const field of form.fields) {
    if (!placeholders.has(field.name))
      issues.push(
        `narrativeTemplate must include {{${field.name}}} so the player's edited answer replaces the default in the opening narrative. Do not hardcode this field's default.`,
      );
    if (field.name === "characterName") continue;
    const value = field.defaultValue;
    if (typeof value !== "string") continue;
    if (
      attributes.get(field.name)?.type !== "enum" &&
      (UNDECIDED[language]?.test(value.trim()) ||
        (field.name === "calling" &&
          UNDECIDED_CALLING[language]?.test(value.trim())))
    ) {
      issues.push(
        `${field.name}.defaultValue is an undecided placeholder (${JSON.stringify(value)}). Choose a concrete value from this world, such as a real calling, rather than leaving the choice undecided.`,
      );
    }
    for (const match of matches) {
      if (match[1].trim() !== field.name) continue;
      const before = boundaryWord(
        segmenter,
        form.narrativeTemplate.slice(0, match.index),
        "end",
      );
      const after = boundaryWord(
        segmenter,
        form.narrativeTemplate.slice(match.index + match[0].length),
        "start",
      );
      const repeated =
        (before &&
          before === boundaryWord(segmenter, value, "start") &&
          before) ||
        (after && after === boundaryWord(segmenter, value, "end") && after);
      if (repeated) {
        issues.push(
          `${field.name}.defaultValue repeats ${JSON.stringify(repeated)} next to {{${field.name}}}. Remove the repeated word from the default or narrativeTemplate; use a short phrase that fits this slot.`,
        );
      }
    }
  }
  if (issues.length) {
    throw new ToolError(
      "invalid-input",
      `${issues.join("\n")}\nFilled narrative: ${defaultNarrative(form)}\nRead the whole sentence, correct the defaults or narrativeTemplate, and call create-character-form again.`,
    );
  }
}
