import { describe, it, expect } from "vitest";
import injectStyleRules from "../hooks/inject-style-rules.js";
import {
  buildStyleRulesText,
  STYLE_RULES_HEADER,
  STYLE_RULES_INTRO,
  CATEGORY_EXPOSITORY,
  CATEGORY_AI_CLICHE,
  CATEGORY_LIVELINESS,
  RULE_NEGATION,
  RULE_CORRECTIVE_NEGATION,
  RULE_EM_DASH,
  RULE_EXPLANATORY_COLON,
  RULE_FINGER_CLICHE,
  RULE_DEGREE_ADVERBS,
  RULE_ACCOUNTING_METAPHOR,
  RULE_FLAT_VOICE,
  RULE_VERBATIM_ECHO,
  RULE_COLLOQUIAL_SPEECH,
  STYLE_RULES_HEADER_EN,
  STYLE_RULES_INTRO_EN,
  CATEGORY_FORMULAIC_EN,
  CATEGORY_AI_CLICHE_EN,
  RULE_CORRECTIVE_NEGATION_EN,
  RULE_EM_DASH_EN,
  RULE_THROAT_CLEARING_EN,
  RULE_TRIADIC_LISTS_EN,
  RULE_DEGREE_ADVERBS_EN,
  RULE_VAGUE_DECLARATIVES_EN,
  RULE_FALSE_AGENCY_EN,
  RULE_BUSINESS_JARGON_EN,
} from "../hooks/_style-rules.js";

const FULL_BLOCK = [
  STYLE_RULES_HEADER,
  "",
  STYLE_RULES_INTRO,
  "",
  CATEGORY_EXPOSITORY,
  `1. ${RULE_NEGATION}`,
  `2. ${RULE_CORRECTIVE_NEGATION}`,
  `3. ${RULE_EM_DASH}`,
  `4. ${RULE_EXPLANATORY_COLON}`,
  "",
  CATEGORY_AI_CLICHE,
  `5. ${RULE_FINGER_CLICHE}`,
  `6. ${RULE_DEGREE_ADVERBS}`,
  `7. ${RULE_ACCOUNTING_METAPHOR}`,
  "",
  CATEGORY_LIVELINESS,
  `8. ${RULE_FLAT_VOICE}`,
  `9. ${RULE_VERBATIM_ECHO}`,
  `10. ${RULE_COLLOQUIAL_SPEECH}`,
].join("\n");

const FULL_BLOCK_EN = [
  STYLE_RULES_HEADER_EN,
  "",
  STYLE_RULES_INTRO_EN,
  "",
  CATEGORY_FORMULAIC_EN,
  `1. ${RULE_CORRECTIVE_NEGATION_EN}`,
  `2. ${RULE_EM_DASH_EN}`,
  `3. ${RULE_THROAT_CLEARING_EN}`,
  `4. ${RULE_TRIADIC_LISTS_EN}`,
  "",
  CATEGORY_AI_CLICHE_EN,
  `5. ${RULE_DEGREE_ADVERBS_EN}`,
  `6. ${RULE_VAGUE_DECLARATIVES_EN}`,
  `7. ${RULE_FALSE_AGENCY_EN}`,
  `8. ${RULE_BUSINESS_JARGON_EN}`,
].join("\n");

const ALL_OFF = {
  banNegation: false,
  banCorrectiveNegation: false,
  banEmDash: false,
  banExplanatoryColon: false,
  banFingerCliche: false,
  banDegreeAdverbs: false,
  banAccountingMetaphor: false,
  banFlatVoice: false,
  banVerbatimEcho: false,
  colloquialDialogue: false,
  banThroatClearing: false,
  banTriadicLists: false,
  banVagueDeclaratives: false,
  banFalseAgency: false,
  banBusinessJargon: false,
};

function ctxWith(settings) {
  return { sessionId: "sess-aaf-1", getOwnSettings: () => settings };
}

const CTX = { sessionId: "sess-aaf-1" };

describe("anti-ai-flavor / buildStyleRulesText", () => {
  it("assembles the full three-category block when every rule is on", () => {
    expect(buildStyleRulesText({})).toBe(FULL_BLOCK);
  });

  it("defaults every rule ON when settings are absent", () => {
    expect(buildStyleRulesText(undefined)).toBe(FULL_BLOCK);
  });

  it("drops a disabled rule and renumbers the survivors gap-free", () => {
    const text = buildStyleRulesText({ banNegation: false });
    expect(text).not.toContain(RULE_NEGATION);
    expect(text).toContain(`1. ${RULE_CORRECTIVE_NEGATION}`);
    expect(text).toContain(`2. ${RULE_EM_DASH}`);
    expect(text).toContain(`3. ${RULE_EXPLANATORY_COLON}`);
    // Cross-category continuous numbering: finger cliché becomes rule 4.
    expect(text).toContain(`4. ${RULE_FINGER_CLICHE}`);
  });

  it("omits a category header when all of its rules are off", () => {
    const text = buildStyleRulesText({
      banFingerCliche: false,
      banDegreeAdverbs: false,
      banAccountingMetaphor: false,
    });
    expect(text).not.toContain(CATEGORY_AI_CLICHE);
    expect(text).toContain(CATEGORY_EXPOSITORY);
    expect(text).toContain(CATEGORY_LIVELINESS);
    // Expository (1-4) + liveliness rules keep continuous numbering 1-7.
    expect(text).toContain(`5. ${RULE_FLAT_VOICE}`);
    expect(text).toContain(`6. ${RULE_VERBATIM_ECHO}`);
    expect(text).toContain(`7. ${RULE_COLLOQUIAL_SPEECH}`);
  });

  it("omits new-rule toggles individually", () => {
    const noLedger = buildStyleRulesText({ banAccountingMetaphor: false });
    expect(noLedger).not.toContain(RULE_ACCOUNTING_METAPHOR);
    expect(noLedger).toContain(`5. ${RULE_FINGER_CLICHE}`);

    const noAdverbs = buildStyleRulesText({ banDegreeAdverbs: false });
    expect(noAdverbs).not.toContain(RULE_DEGREE_ADVERBS);
    expect(noAdverbs).toContain(`6. ${RULE_ACCOUNTING_METAPHOR}`);

    const noVoice = buildStyleRulesText({ banFlatVoice: false });
    expect(noVoice).not.toContain(RULE_FLAT_VOICE);
    expect(noVoice).toContain(`8. ${RULE_VERBATIM_ECHO}`);

    const noColloquial = buildStyleRulesText({ colloquialDialogue: false });
    expect(noColloquial).not.toContain(RULE_COLLOQUIAL_SPEECH);
    expect(noColloquial).toContain(`9. ${RULE_VERBATIM_ECHO}`);
  });

  it("returns an empty string when every rule is off", () => {
    expect(buildStyleRulesText(ALL_OFF)).toBe("");
    expect(buildStyleRulesText(ALL_OFF, "en")).toBe("");
  });
});

describe("anti-ai-flavor / buildStyleRulesText (en table)", () => {
  it("assembles the full two-category block when every rule is on", () => {
    expect(buildStyleRulesText({}, "en")).toBe(FULL_BLOCK_EN);
  });

  it("drops a disabled en-only rule and renumbers the survivors gap-free", () => {
    const text = buildStyleRulesText({ banThroatClearing: false }, "en");
    expect(text).not.toContain(RULE_THROAT_CLEARING_EN);
    expect(text).toContain(`3. ${RULE_TRIADIC_LISTS_EN}`);
    expect(text).toContain(`4. ${RULE_DEGREE_ADVERBS_EN}`);
  });

  it("honours shared keys in the en table", () => {
    const text = buildStyleRulesText(
      { banCorrectiveNegation: false, banEmDash: false },
      "en",
    );
    expect(text).not.toContain(RULE_CORRECTIVE_NEGATION_EN);
    expect(text).not.toContain(RULE_EM_DASH_EN);
    expect(text).toContain(`1. ${RULE_THROAT_CLEARING_EN}`);
  });

  it("silently skips zh-only keys in the en table and vice versa", () => {
    const en = buildStyleRulesText({}, "en");
    expect(en).not.toContain(RULE_NEGATION);
    expect(en).not.toContain(RULE_COLLOQUIAL_SPEECH);
    const zh = buildStyleRulesText({}, "zh");
    expect(zh).not.toContain(RULE_THROAT_CLEARING_EN);
  });

  it("omits an en category header when all of its rules are off", () => {
    const text = buildStyleRulesText(
      {
        banDegreeAdverbs: false,
        banVagueDeclaratives: false,
        banFalseAgency: false,
        banBusinessJargon: false,
      },
      "en",
    );
    expect(text).not.toContain(CATEGORY_AI_CLICHE_EN);
    expect(text).toContain(CATEGORY_FORMULAIC_EN);
  });
});

describe("anti-ai-flavor / inject-style-rules (PostContextAssembly)", () => {
  it("appends the full block to a zh-CN story runtime's system prompt", async () => {
    const r = await injectStyleRules(ctxWith({}), {
      outputKind: "story",
      systemPrompt: "BASE_SYSTEM_PROMPT",
      locale: "zh-CN",
    });
    expect(r.action).toBe("continue");
    expect(r.replace.systemPrompt).toBe(
      "BASE_SYSTEM_PROMPT" + "\n\n" + FULL_BLOCK,
    );
  });

  it("injects for zh aliases as well (zh → zh-CN)", async () => {
    const r = await injectStyleRules(ctxWith({}), {
      outputKind: "story",
      systemPrompt: "BASE",
      locale: "zh",
    });
    expect(r.replace.systemPrompt).toBe("BASE" + "\n\n" + FULL_BLOCK);
  });

  it("preserves the original prompt verbatim as the prefix", async () => {
    const base = "你是叙事者。\n遵循世界设定。";
    const r = await injectStyleRules(ctxWith({}), {
      outputKind: "story",
      systemPrompt: base,
      locale: "zh-CN",
    });
    expect(r.replace.systemPrompt.startsWith(base + "\n\n")).toBe(true);
    expect(r.replace.systemPrompt.endsWith(RULE_COLLOQUIAL_SPEECH)).toBe(true);
  });

  it("injects the en table for en story sessions", async () => {
    const r = await injectStyleRules(ctxWith({}), {
      outputKind: "story",
      systemPrompt: "BASE",
      locale: "en-US",
    });
    expect(r.replace.systemPrompt).toBe("BASE" + "\n\n" + FULL_BLOCK_EN);
  });

  it("matches any en* locale (en → en table)", async () => {
    const r = await injectStyleRules(ctxWith({ banTriadicLists: false }), {
      outputKind: "story",
      systemPrompt: "BASE",
      locale: "en",
    });
    expect(r.replace.systemPrompt).toContain(RULE_THROAT_CLEARING_EN);
    expect(r.replace.systemPrompt).not.toContain(RULE_TRIADIC_LISTS_EN);
  });

  it("leaves non-zh/en story sessions untouched (no matching rule table)", async () => {
    const r = await injectStyleRules(ctxWith({}), {
      outputKind: "story",
      systemPrompt: "BASE",
      locale: "ru-RU",
    });
    expect(r).toEqual({ action: "continue" });
  });

  it("treats a missing locale as non-zh (no injection)", async () => {
    const r = await injectStyleRules(ctxWith({}), {
      outputKind: "story",
      systemPrompt: "BASE",
    });
    expect(r).toEqual({ action: "continue" });
  });

  it("leaves plugin-kind runtimes untouched (no replace)", async () => {
    const r = await injectStyleRules(ctxWith({}), {
      outputKind: "plugin",
      systemPrompt: "CODEX_PROMPT",
      locale: "zh-CN",
    });
    expect(r).toEqual({ action: "continue" });
  });

  it("leaves system-kind runtimes untouched (no replace)", async () => {
    const r = await injectStyleRules(ctxWith({}), {
      outputKind: "system",
      systemPrompt: "SYSTEM_PROMPT",
      locale: "zh-CN",
    });
    expect(r).toEqual({ action: "continue" });
  });

  it("treats a missing outputKind as non-story (no replace)", async () => {
    const r = await injectStyleRules(ctxWith({}), {
      systemPrompt: "UNKNOWN_PROMPT",
      locale: "zh-CN",
    });
    expect(r).toEqual({ action: "continue" });
  });

  it("does not throw when the payload is absent", async () => {
    const r = await injectStyleRules(ctxWith({}), undefined);
    expect(r).toEqual({ action: "continue" });
  });

  it("injects nothing when every rule is toggled off", async () => {
    const r = await injectStyleRules(ctxWith(ALL_OFF), {
      outputKind: "story",
      systemPrompt: "BASE",
      locale: "zh-CN",
    });
    expect(r).toEqual({ action: "continue" });
  });

  it("honours per-session toggles from getOwnSettings", async () => {
    const r = await injectStyleRules(
      ctxWith({ banEmDash: false, banFingerCliche: false }),
      { outputKind: "story", systemPrompt: "BASE", locale: "zh-CN" },
    );
    expect(r.replace.systemPrompt).not.toContain(RULE_EM_DASH);
    expect(r.replace.systemPrompt).not.toContain(RULE_FINGER_CLICHE);
    expect(r.replace.systemPrompt).toContain(`1. ${RULE_NEGATION}`);
    expect(r.replace.systemPrompt).toContain(`2. ${RULE_CORRECTIVE_NEGATION}`);
    // With em-dash off, explanatory colon takes number 3.
    expect(r.replace.systemPrompt).toContain(`3. ${RULE_EXPLANATORY_COLON}`);
  });

  it("falls back to manifest defaults when getOwnSettings is absent (out of hook scope)", async () => {
    const r = await injectStyleRules(CTX, {
      outputKind: "story",
      systemPrompt: "BASE",
      locale: "zh-CN",
    });
    expect(r.replace.systemPrompt).toBe("BASE" + "\n\n" + FULL_BLOCK);
  });
});
