import { blankCssNonCode, parseImportedThemeFile } from "./validate.js";

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Declaration {
  name: string;
  start: number;
  end: number;
}

// CSS escapes apply to both quoted names and identifiers.
function decodeName(value: string): string {
  const unquoted = /^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value;
  return unquoted.replace(
    /\\([\da-f]{1,6}\s?|[^\n\r\f])/gi,
    (_, escaped: string) =>
      /^[\da-f]/i.test(escaped)
        ? String.fromCodePoint(
            Math.min(Number.parseInt(escaped.trim(), 16) || 0xfffd, 0x10ffff),
          )
        : escaped,
  );
}

/** Top-level whitespace/comma tokens; functions and quoted names stay intact. */
function valueTokens(value: string): Edit[] {
  const tokens: Edit[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i <= value.length; i++) {
    const character = value[i];
    if (character === '"' || character === "'") {
      const quote = character;
      while (++i < value.length && value[i] !== quote) {
        if (value[i] === "\\") i++;
      }
      continue;
    }
    if (character === "\\") {
      const escape = /^\\(?:[\da-f]{1,6}\s?|.)/is.exec(value.slice(i));
      i += (escape?.[0].length ?? 2) - 1;
      continue;
    }
    if (character === "/" && value[i + 1] === "*") {
      if (depth === 0 && start < i)
        tokens.push({ start, end: i, text: value.slice(start, i) });
      const end = value.indexOf("*/", i + 2);
      i = end === -1 ? value.length : end + 1;
      if (depth === 0) start = i + 1;
      continue;
    }
    if (character === "(") depth++;
    else if (character === ")") depth--;
    if (
      i === value.length ||
      (depth === 0 && (character === "," || /\s/.test(value[i] ?? "")))
    ) {
      if (start < i)
        tokens.push({ start, end: i, text: value.slice(start, i) });
      if (character === ",") tokens.push({ start: i, end: i + 1, text: "," });
      start = i + 1;
    }
  }
  return tokens;
}

function applyEdits(text: string, edits: Edit[]): string {
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) =>
        result.slice(0, edit.start) + edit.text + result.slice(edit.end),
      text,
    );
}

const ANIMATION_KEYWORDS = [
  [
    "ease",
    "linear",
    "ease-in",
    "ease-out",
    "ease-in-out",
    "step-start",
    "step-end",
  ],
  ["normal", "reverse", "alternate", "alternate-reverse"],
  ["none", "forwards", "backwards", "both"],
  ["running", "paused"],
  ["infinite"],
  ["auto"],
];

function rewriteAnimation(
  value: string,
  names: ReadonlyMap<string, string>,
  shorthand: boolean,
  useVariable: (name: string, shorthand: boolean) => void,
): string {
  const edits: Edit[] = [];
  const usedKeywords = new Set<number>();
  for (const token of valueTokens(value)) {
    if (token.text === ",") {
      usedKeywords.clear();
      continue;
    }
    const variable = /^var\(\s*(--[\w-]+)/i.exec(token.text);
    if (variable) {
      useVariable(variable[1]!, shorthand);
      const comma = token.text.indexOf(",");
      if (comma !== -1) {
        edits.push({
          ...token,
          text:
            token.text.slice(0, comma + 1) +
            rewriteAnimation(
              token.text.slice(comma + 1, -1),
              names,
              shorthand,
              useVariable,
            ) +
            ")",
        });
      }
      continue;
    }
    const name = decodeName(token.text);
    if (shorthand && !/^["']/.test(token.text)) {
      const keyword = ANIMATION_KEYWORDS.findIndex((group) =>
        group.includes(name.toLowerCase()),
      );
      if (keyword !== -1 && !usedKeywords.has(keyword)) {
        usedKeywords.add(keyword);
        continue;
      }
      if (/^(?:cubic-bezier|steps|linear)\(/i.test(token.text))
        usedKeywords.add(0);
    }
    const replacement = names.get(name);
    if (replacement) edits.push({ ...token, text: replacement });
  }
  return applyEdits(value, edits);
}

/**
 * Retain the source text, including rules this browser does not yet understand.
 * CSSOM serialization would silently drop them. Only selectors and animation
 * identifiers are edited; the normal importer validates both ends.
 */
export function deriveThemeCss(
  cssText: string,
  sourceId: string,
  themeId: string,
): string {
  const source = parseImportedThemeFile(cssText, `${sourceId}.css`).theme;
  if (source.id !== sourceId) throw new Error("Theme CSS source id mismatch.");
  const masked = blankCssNonCode(cssText, true);
  const edits: Edit[] = [];
  const names = new Map<string, string>();
  const keyframes: Array<Edit & { name: string }> = [];
  const declarations: Declaration[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;

  const readDeclaration = (end: number) => {
    const statement = masked.slice(start, end);
    const property = /^\s*(--[\w-]+|[\w-]+)\s*:/.exec(statement);
    if (property)
      declarations.push({
        name: property[1]!.startsWith("--")
          ? property[1]!
          : property[1]!.toLowerCase(),
        start: start + property[0].length,
        end,
      });
  };

  for (let i = 0; i < cssText.length; i++) {
    const character = masked[i];
    if (character === "(") parentheses++;
    if (character === ")") parentheses--;
    if (character === "[") {
      brackets++;
      const selector = /^\[\s*data-theme\s*=\s*(["'])([a-z0-9-]+)\1\s*\]/.exec(
        cssText.slice(i),
      );
      if (selector?.[2] === sourceId)
        edits.push({
          start: i,
          end: i + selector[0].length,
          text: `[data-theme="${themeId}"]`,
        });
    }
    if (character === "]") brackets--;
    if (parentheses !== 0 || brackets !== 0) continue;
    if (character === "{") {
      const prelude = cssText.slice(start, i);
      const keyframe = /^\s*@(?:-webkit-)?keyframes\s+/.exec(
        blankCssNonCode(prelude),
      );
      if (keyframe) {
        const nameStart = start + keyframe[0].length;
        const rawName = valueTokens(cssText.slice(nameStart, i))[0]?.text ?? "";
        const name = decodeName(rawName);
        if (!names.has(name)) names.set(name, `covel-${themeId}-${names.size}`);
        keyframes.push({
          start: nameStart,
          end: nameStart + rawName.length,
          text: "",
          name,
        });
      }
      start = i + 1;
    } else if (character === ";" || character === "}") {
      readDeclaration(i);
      start = i + 1;
    }
  }

  for (const keyframe of keyframes)
    edits.push({ ...keyframe, text: names.get(keyframe.name)! });

  const variables = new Map<string, boolean>();
  const pendingVariables: string[] = [];
  const useVariable = (name: string, shorthand: boolean) => {
    // Explicit animation-name usage is more specific than a shorthand.
    const next = (variables.get(name) ?? true) && shorthand;
    if (variables.get(name) !== next) {
      variables.set(name, next);
      pendingVariables.push(name);
    }
  };
  const rewrite = (declaration: Declaration, shorthand: boolean) => {
    const value = cssText.slice(declaration.start, declaration.end);
    const priority = /!\s*important\s*$/i.exec(blankCssNonCode(value, true));
    const end = priority?.index ?? value.length;
    return {
      ...declaration,
      text:
        rewriteAnimation(value.slice(0, end), names, shorthand, useVariable) +
        value.slice(end),
    };
  };
  for (const declaration of declarations) {
    if (/^(?:-webkit-)?animation(?:-name)?$/.test(declaration.name))
      edits.push(rewrite(declaration, !declaration.name.endsWith("-name")));
  }
  const rewrittenVariables = new Map<Declaration, Edit>();
  // Follow custom-property references without repeatedly rewriting cycles.
  for (let index = 0; index < pendingVariables.length; index++) {
    const name = pendingVariables[index]!;
    const shorthand = variables.get(name)!;
    for (const declaration of declarations) {
      if (declaration.name === name)
        rewrittenVariables.set(declaration, rewrite(declaration, shorthand));
    }
  }
  edits.push(...rewrittenVariables.values());

  const derived = applyEdits(cssText, edits);
  parseImportedThemeFile(derived, `${themeId}.css`);
  return derived;
}
