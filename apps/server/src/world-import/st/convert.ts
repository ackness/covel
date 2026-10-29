import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { canonicalizeLocale, type StImportReport } from "@covel/shared";
import type { ExtractedEntry } from "../../routes/api/install/shared.js";
import { SAFE_WORLD_ID_RE } from "../../lib/validators.js";
import { parseCard, type ParsedCard } from "./card-schema.js";
import { parseLorebook, type ParsedLorebook } from "./lorebook-schema.js";
import { convertLorebook, type LoreEntry } from "./convert-lorebook.js";
import {
  extractCardJson,
  isPng,
  MAX_CARD_JSON_BYTES,
  stripPngTextChunks,
} from "./png-chunks.js";
import { cutText, sanitizeText } from "./sanitize-text.js";
import { resolveMacros } from "./macros.js";
import { ImportReporter, safeFieldName, StImportError } from "./report.js";

export const MAX_ST_FILE_BYTES = 8 * 1024 * 1024;
const hash = (name: string) =>
  createHash("sha256").update(name).digest("hex").slice(0, 8);
export function slug(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/, "");
}
export async function chooseWorldId(
  name: string,
  isIdTaken: (id: string) => Promise<boolean>,
): Promise<string> {
  const candidate = slug(name);
  const base = /^[a-z]/.test(candidate) ? candidate : `st-${hash(name)}`;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const id = base.slice(0, 48 - suffix.length).replace(/-$/, "") + suffix;
    if (SAFE_WORLD_ID_RE.test(id) && !(await isIdTaken(id))) return id;
  }
  throw new StImportError(
    "id-conflict",
    "World id is already taken; try another name",
    409,
  );
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .replace(/^\uFEFF/, ""),
    ) as unknown;
  } catch {
    throw new StImportError("json-invalid", "Invalid UTF-8 JSON");
  }
}

/** Bound unknown loose-object fields too, without recursively parsing executable content. */
function checkInputBounds(json: unknown): void {
  const pending: { value: unknown; depth: number }[] = [
    { value: json, depth: 0 },
  ];
  while (pending.length) {
    const next = pending.pop()!;
    if (next.depth > 64)
      throw new StImportError("json-invalid", "JSON nesting exceeds 64 levels");
    if (
      typeof next.value === "string" &&
      next.value.length > MAX_CARD_JSON_BYTES
    )
      throw new StImportError("json-too-large", "JSON string exceeds limit");
    if (next.value && typeof next.value === "object") {
      const values: unknown[] = Object.values(next.value);
      if (values.length > 100000)
        throw new StImportError(
          "json-too-large",
          "JSON collection exceeds limit",
        );
      for (const value of values)
        pending.push({ value, depth: next.depth + 1 });
    }
  }
}

function sourceText(source: string, reporter: ImportReporter, locale: string) {
  let name = "";
  let html = 0;
  let macros = 0;
  const names = new Set<string>();
  function text(
    value: string | undefined,
    field: string,
    limit = 12000,
  ): string {
    const resolved = resolveMacros(value ?? "", name, locale);
    macros += resolved.removed;
    for (const item of resolved.names) if (names.size < 10) names.add(item);
    const cleaned = sanitizeText(resolved.text);
    html += cleaned.removed;
    let result = cleaned.text;
    if (result.length > limit) {
      const boundary = result.lastIndexOf("\n\n", limit);
      result = result
        .slice(0, boundary > limit / 2 ? boundary : limit)
        .replace(/[\uD800-\uDBFF]$/, "");
      reporter.add(
        "warning",
        "text-truncated",
        source,
        "Text was shortened to the destination limit",
        field,
      );
    }
    return result;
  }
  return {
    text,
    setName(value: string) {
      name = value;
    },
    finish() {
      if (html)
        reporter.add(
          "info",
          "html-removed",
          source,
          "HTML or unsafe link constructs were removed",
          undefined,
          html,
        );
      if (macros)
        reporter.add(
          "warning",
          "macros-removed",
          source,
          `Unsupported macros were removed: ${[...names].join(", ")}`,
          undefined,
          macros,
        );
    },
  };
}
function dialogueExamples(
  input: string,
  text: (value: string, field: string, limit?: number) => string,
): { user?: string; character: string }[] {
  const examples: { user?: string; character: string }[] = [];
  for (const block of input.split(/^\s*<START>\s*$/im)) {
    let speaker: "user" | "character" | undefined;
    let user = "";
    let character = "";
    for (const line of block.split(/\r?\n/)) {
      const marker =
        /^\s*(\{\{user\}\}|<USER>|\{\{char\}\}|<BOT>):\s*(.*)$/i.exec(line);
      if (marker) speaker = /user/i.test(marker[1]!) ? "user" : "character";
      const value = marker?.[2] ?? line;
      if (speaker === "user") user += (user ? "\n" : "") + value;
      if (speaker === "character") character += (character ? "\n" : "") + value;
    }
    const cleaned = text(character, "mes_example", 4000).trim();
    if (cleaned)
      examples.push({
        ...(user.trim()
          ? { user: text(user, "mes_example", 4000).trim() }
          : {}),
        character: cleaned,
      });
  }
  return examples;
}

export async function convertStImport(input: {
  files: { name: string; bytes: Uint8Array }[];
  worldName?: string;
  locale: string;
  isIdTaken(id: string): Promise<boolean>;
}): Promise<{ entries: ExtractedEntry[]; report: StImportReport }> {
  if (!input.files.length)
    throw new StImportError("files-required", "At least one file is required");
  if (input.files.length > 8)
    throw new StImportError("files-limit", "At most 8 files may be imported");
  const locale = canonicalizeLocale(input.locale);
  if (!locale)
    throw new StImportError("locale-invalid", "Invalid BCP 47 locale");
  const requestReporter = new ImportReporter();
  const sources: StImportReport["sources"] = [];
  const characters: Record<string, unknown>[] = [];
  const lore: LoreEntry[] = [];
  const loreIds = new Set<string>();
  const characterIds = new Set<string>();
  const budget = { seen: 0 };
  const scenarios: { name: string; text: string }[] = [];
  const notes: string[] = [];
  const tags = new Set<string>();
  let cover: Uint8Array | undefined;
  let firstCard:
    | {
        name: string;
        description: string;
        opening: string;
      }
    | undefined;
  let firstBookName = "";
  let author = "";
  let summaryNotes = "";
  for (const file of input.files) {
    const reporter = new ImportReporter();
    if (file.bytes.byteLength > MAX_ST_FILE_BYTES)
      throw new StImportError("file-too-large", "File exceeds 8 MiB", 413);
    const filenameText = sanitizeText(
      file.name.replace(/\\/g, "/").split("/").pop() ?? "upload",
    );
    const source =
      filenameText.text.replace(/[\\/]/g, "").slice(0, 255) || "upload";
    if (filenameText.removed)
      reporter.add(
        "info",
        "html-removed",
        source,
        "HTML or unsafe link constructs were removed",
        undefined,
        filenameText.removed,
      );
    const processor = sourceText(source, reporter, locale);
    const { text } = processor;
    let json: unknown;
    const png = isPng(file.bytes);
    if (png) json = extractCardJson(file.bytes).json;
    else {
      const prefix = new TextDecoder()
        .decode(file.bytes)
        .replace(/^\uFEFF/, "")
        .trimStart();
      if (!prefix.startsWith("{"))
        throw new StImportError(
          "unsupported-file",
          "Expected a character card PNG or JSON object",
        );
      json = parseJson(file.bytes);
    }
    checkInputBounds(json);
    const isBook =
      !png &&
      typeof json === "object" &&
      json !== null &&
      "entries" in json &&
      !("spec" in json) &&
      !("data" in json);
    if (!isBook && file.bytes.byteLength > MAX_CARD_JSON_BYTES && !png)
      throw new StImportError("json-too-large", "Card JSON exceeds 3 MiB");
    let card: ParsedCard | undefined;
    let book: ParsedLorebook | undefined;
    let name: string;
    if (isBook) {
      book = parseLorebook(json);
      name = text(book.name, "name", 80).trim();
      if (!firstBookName) firstBookName = name;
      sources.push({
        file: source,
        kind: "lorebook",
        ...(name ? { name } : {}),
      });
    } else {
      card = parseCard(json);
      name = text(card.name, "name", 80).trim();
      if (!name)
        throw new StImportError(
          "card-no-name",
          "Character card must have a non-empty name",
        );
      processor.setName(name);
      if (characters.length >= 6)
        throw new StImportError(
          "cards-limit",
          "At most 6 character cards may be imported",
        );
      sources.push({ file: source, kind: card.kind, name });
      if (card.kind === "card-v1")
        reporter.add(
          "info",
          "v1-card",
          source,
          "Flat V1 character card was accepted",
        );
      const candidate = slug(name);
      const base = `npc-${/^[a-z]/.test(candidate) ? candidate : hash(name)}`;
      let id = base;
      for (let n = 2; characterIds.has(id); n++) id = `${base}-${n}`;
      characterIds.add(id);
      const description = text(card.description, "description", 12000);
      const personality = text(card.personality, "personality", 2000);
      const opening = text(card.first_mes, "first_mes", 4000);
      const nickname = text(card.nickname, "nickname", 80).trim();
      const allExamples = dialogueExamples(card.mes_example ?? "", text);
      const examples = allExamples.slice(0, 10);
      if (allExamples.length > 10)
        reporter.add(
          "info",
          "field-ignored",
          source,
          "Dialogue examples beyond the limit of 10 were omitted",
          "mes_example",
          allExamples.length - 10,
        );
      if (card.mes_example && !examples.length)
        reporter.add(
          "warning",
          "mes-example-unparsed",
          source,
          "Dialogue examples could not be parsed",
        );
      characters.push({
        id,
        name,
        type: "npc",
        description,
        ...(nickname && nickname !== name ? { aliases: [nickname] } : {}),
        blueprint: {
          ...(personality ? { persona: { summary: personality } } : {}),
          ...(opening ? { scenarioDefaults: { opening } } : {}),
          ...(examples.length ? { dialogueExamples: examples } : {}),
        },
      });
      const scenario = text(card.scenario, "scenario").trim();
      if (scenario) scenarios.push({ name, text: scenario });
      for (const field of [
        "system_prompt",
        "post_history_instructions",
      ] as const) {
        const value = text(card[field], field).trim();
        if (value) {
          notes.push(
            `${field === "post_history_instructions" ? "Reminder:\n" : ""}${value}`,
          );
          reporter.add(
            "warning",
            "instructions-in-world-text",
            source,
            "Card instructions were included as plain narration notes",
            field,
          );
        }
      }
      const creatorNotes =
        text(card.creator_notes, "creator_notes")
          .trim()
          .split(/\n\s*\n/)[0] ?? "";
      firstCard ??= { name, description, opening };
      summaryNotes ||= creatorNotes;
      if (!author) author = text(card.creator, "creator", 120).trim();
      for (const field of card.ignored)
        reporter.add(
          "info",
          "field-ignored",
          source,
          "Unmapped character card field was omitted",
          safeFieldName(field),
        );
      if (card.group_only_greetings?.length)
        reporter.add(
          "info",
          "field-ignored",
          source,
          "Group-only greetings were omitted",
          "group_only_greetings",
          card.group_only_greetings.length,
        );
      if (card.alternate_greetings?.length)
        reporter.add(
          "warning",
          "alternate-greetings-unsupported",
          source,
          "Alternate greetings have no opening selector and were omitted",
          "alternate_greetings",
          card.alternate_greetings.length,
        );
      const extensionKeys = Object.keys(card.extensions ?? {});
      if (extensionKeys.length)
        reporter.add(
          "warning",
          "extensions-ignored",
          source,
          `Extensions were omitted: ${extensionKeys.slice(0, 20).map(safeFieldName).join(", ")}`,
          "extensions",
          extensionKeys.length,
        );
      if (card.character_book) book = parseLorebook(card.character_book);
      if (png && !cover) cover = stripPngTextChunks(file.bytes);
    }
    for (const tag of [...(card?.tags ?? []), ...(book?.tags ?? [])]) {
      const normalized = text(tag, "tags", 200)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-");
      if (normalized.length > 32)
        reporter.add(
          "warning",
          "text-truncated",
          source,
          "Tag was shortened to 32 characters",
          "tags",
        );
      if (normalized) tags.add(cutText(normalized, 32));
    }
    if (book)
      lore.push(
        ...convertLorebook(book, {
          source,
          sourceSlug: slug(name || book.name || "lore") || "lore",
          reporter,
          text,
          usedIds: loreIds,
          budget,
        }),
      );
    processor.finish();
    requestReporter.items.push(...reporter.items);
  }
  const reporter = requestReporter;
  const requested = sourceText("world name", reporter, locale);
  const name =
    requested.text(input.worldName, "name", 80).trim() ||
    firstCard?.name ||
    firstBookName ||
    "SillyTavern import";
  requested.finish();
  if (tags.size > 12)
    reporter.add(
      "info",
      "field-ignored",
      "world tags",
      "Tags beyond the limit of 12 were omitted",
      "tags",
      tags.size - 12,
    );
  const id = await chooseWorldId(name, input.isIdTaken);
  const summary = (
    cutText(summaryNotes, 280) ||
    cutText(firstCard?.description ?? "", 200) ||
    name
  ).trim();
  const sections = [`# ${name.replace(/\n/g, " ")}`];
  if (scenarios.length)
    sections.push(
      `## Scenario\n\n${scenarios.map((item) => `${characters.length > 1 ? `### ${item.name.replace(/\n/g, " ")}\n\n` : ""}${item.text}`).join("\n\n")}`,
    );
  if (firstCard?.opening) sections.push(`## Opening\n\n${firstCard.opening}`);
  if (notes.length)
    sections.push(`## Narration notes\n\n${notes.join("\n\n")}`);
  if (sections.length === 1) {
    // A lorebook-only world uses its first usable entry as the premise.
    const premise = firstCard
      ? cutText(firstCard.description, 1200).trim()
      : cutText(lore[0]?.content ?? "", 1200);
    if (!premise)
      throw new StImportError(
        "no-usable-text",
        "No usable scenario, opening, description or lorebook text",
      );
    sections.push(`## Premise\n\n${premise}`);
  }
  const entries: ExtractedEntry[] = [];
  function add(relativePath: string, content: string | Uint8Array) {
    entries.push({ relativePath, content: Buffer.from(content) });
  }
  add(
    "world.yaml",
    stringify({
      id,
      name,
      version: "1.0.0",
      summary,
      defaultLocale: locale,
      tags: [...tags].slice(0, 12),
      ...(author ? { author: { name: author } } : {}),
      ...(cover ? { cover: "media/gallery/cover.png" } : {}),
      pluginPolicy: { preset: "dialogue-mode" },
    }),
  );
  add("WORLD.md", sections.join("\n\n") + "\n");
  if (characters.length)
    add(
      "characters/characters.json",
      JSON.stringify(characters, null, 2) + "\n",
    );
  if (lore.length) {
    const yaml = stringify(lore);
    if (Buffer.byteLength(yaml) > 2 * 1024 * 1024)
      throw new StImportError(
        "lorebook-too-large",
        "Converted lorebook exceeds 2 MiB",
      );
    add("data/lorebook.yaml", yaml);
  }
  if (cover) add("media/gallery/cover.png", cover);
  return {
    entries,
    report: {
      sources,
      world: { id, name, locale, summary },
      counts: {
        characters: characters.length,
        loreEntries: lore.length,
        hasCover: !!cover,
      },
      items: reporter.items,
    },
  };
}
