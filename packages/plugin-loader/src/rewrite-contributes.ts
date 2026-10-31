import { isDeepStrictEqual } from "node:util";
import {
  CST,
  Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type YAMLSeq,
} from "yaml";
import {
  isModelFacingServiceContribution,
  pluginManifestSchema,
  serviceContributionAccess,
  serviceContributionContract,
  serviceContributionSchema,
  type PluginManifest,
  type ServiceContribution,
} from "@covel/shared";
import { readPlainYamlFrontmatter } from "./plain-yaml-frontmatter.js";

export const EXTRACTED_KINDS = [
  "tools",
  "actions",
  "services",
  "forms",
  "wires",
  "hooks",
] as const;
type Kind = (typeof EXTRACTED_KINDS)[number];
type Contributions = NonNullable<PluginManifest["contributes"]>;
export interface ExtractedDeclarations {
  readonly tools: readonly string[];
  readonly actions: readonly string[];
  readonly services: readonly ServiceContribution[];
  readonly forms: readonly string[];
  readonly wires: readonly string[];
  readonly hooks: readonly (
    string | { readonly event: string; readonly enforce: "pre" | "post" }
  )[];
  /** Recorded registrations; declaration-only extension metadata is never rewritten. */
  readonly extensions: readonly string[];
  /** Commands have no registration API; report the authored metadata. */
  readonly commands: NonNullable<Contributions["commands"]>;
  readonly localizedContributes: readonly string[];
}
interface DeclarationDrift {
  readonly key: Kind;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

function names(values: readonly unknown[], key: Kind): string[] {
  return values.map((value) => {
    if (key !== "hooks" && typeof value === "string") return value;
    if (key === "services") {
      const service = serviceContributionSchema.parse(value);
      const markers = [
        ...(isModelFacingServiceContribution(service) ? ["model-facing"] : []),
        ...(serviceContributionAccess(service) === "write" ? ["write"] : []),
      ];
      return markers.length > 0
        ? `${serviceContributionContract(service)} (${markers.join(", ")})`
        : serviceContributionContract(service);
    }
    const hook = pluginManifestSchema.shape.contributes
      .unwrap()
      .shape.hooks.unwrap()
      .element.parse(value);
    return `${hook.event}:${hook.enforce ?? "normal"}`;
  });
}

/** Collect CST comments, including comments on removed list entries. */
function comments(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if ("type" in value && value.type === "comment" && "source" in value)
    return [String(value.source)];
  return Object.values(value).flatMap(comments);
}

function commentTokens(
  lines: readonly string[],
  indent: number,
  newline: string,
): CST.SourceToken[] {
  return lines.flatMap((source) => [
    { type: "space" as const, source: " ".repeat(indent), indent, offset: 0 },
    { type: "comment" as const, source, indent, offset: 0 },
    { type: "newline" as const, source: newline, indent, offset: 0 },
  ]);
}

function mapToken(value: unknown): CST.BlockMap | CST.FlowCollection {
  if (
    !isMap(value) ||
    !value.srcToken ||
    (value.srcToken.type !== "block-map" &&
      value.srcToken.type !== "flow-collection")
  )
    throw new Error("contributes must be a YAML mapping");
  return value.srcToken;
}

function pairToken(
  key: string,
  values: unknown,
  indent: number,
  flow: boolean,
  newline: string,
): CST.CollectionItem & { key: CST.Token | null; sep: CST.SourceToken[] } {
  const doc = new Document({ [key]: values });
  if (isMap(doc.contents)) doc.contents.flow = flow;
  const source = doc
    .toString({ lineWidth: 0 })
    .split("\n")
    .map((line) => (line ? " ".repeat(indent) + line : line))
    .join(newline);
  const token = mapToken(
    parseDocument(source, { keepSourceTokens: true }).contents,
  );
  const item = token.items[0];
  if (!item?.key || !item.sep) throw new Error("Cannot render declaration");
  return { ...item, key: item.key, sep: item.sep };
}

function isMappingPair(item: CST.CollectionItem): boolean {
  return item.key !== undefined || item.value !== undefined;
}

function insertPairs(
  token: CST.BlockMap | CST.FlowCollection,
  additions: readonly CST.CollectionItem[],
): void {
  let insertion = 0;
  for (const [index, item] of token.items.entries()) {
    if (isMappingPair(item)) insertion = index + 1;
  }
  const pairs = additions.map((item, index) => {
    if (token.type !== "block-map" || insertion + index === 0) return item;
    // A standalone document holds its first line's indentation outside the pair.
    return {
      ...item,
      start: [
        {
          type: "space" as const,
          source: " ".repeat(token.indent),
          indent: 0,
          offset: 0,
        },
        ...item.start,
      ],
    };
  });
  token.items = [
    ...token.items.slice(0, insertion),
    ...pairs,
    ...token.items.slice(insertion),
  ];
}

function delimiters(token: CST.BlockMap | CST.FlowCollection): void {
  if (token.type !== "flow-collection") return;
  let seenPair = false;
  for (const item of token.items) {
    if (!isMappingPair(item) && seenPair) continue; // Preserve a trailing comma and its trivia.
    item.start = item.start.filter((part) => part.type !== "comma");
    if (!isMappingPair(item)) continue;
    if (seenPair)
      item.start.unshift({
        type: "comma",
        source: ",",
        indent: token.indent,
        offset: 0,
      });
    seenPair = true;
  }
}

/**
 * Rewrite only the six registration lists. The Document API supplies typed
 * nodes and rendering; its source tokens keep every untouched byte intact.
 */
export function rewriteContributes(
  pluginMd: string,
  extracted: ExtractedDeclarations,
): {
  text: string;
  changed: readonly string[];
  drift: readonly DeclarationDrift[];
} {
  readPlainYamlFrontmatter(pluginMd); // Reject executable frontmatter before parsing YAML.
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(pluginMd);
  if (!opening) throw new Error("Manifest requires plain YAML frontmatter");
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(
    pluginMd.slice(opening[0].length),
  );
  if (!closing) throw new Error("Manifest requires plain YAML frontmatter");
  const offset = opening[0].length;
  const yaml = pluginMd.slice(offset, offset + closing.index);
  const newline = opening[0].endsWith("\r\n") ? "\r\n" : "\n";
  const doc = parseDocument(yaml, { keepSourceTokens: true });
  if (doc.errors.length) throw doc.errors[0];
  const fields = pluginManifestSchema.shape.contributes.unwrap().shape;
  for (const key of EXTRACTED_KINDS) fields[key].parse(extracted[key]);
  if (doc.contents === null) {
    const changed = EXTRACTED_KINDS.filter((key) => extracted[key].length > 0);
    const drift = changed.map((key) => ({
      key,
      added: names(extracted[key], key),
      removed: [],
    }));
    const rendered = changed.length
      ? new Document({
          contributes: Object.fromEntries(
            changed.map((key) => [key, extracted[key]]),
          ),
        })
          .toString({ lineWidth: 0 })
          .replace(/\n/g, newline)
      : "";
    return {
      text:
        pluginMd.slice(0, offset + yaml.length) +
        rendered +
        pluginMd.slice(offset + yaml.length),
      changed,
      drift,
    };
  }
  if (!isMap(doc.contents))
    throw new Error("Manifest frontmatter must be a YAML mapping");
  const root = mapToken(doc.contents);
  const original = CST.stringify(root);
  const node = doc.get("contributes", true);
  const contribution = node === undefined ? undefined : mapToken(node);
  const drift: DeclarationDrift[] = [];
  const changed: Kind[] = [];
  const removedComments: string[] = [];
  const additions: CST.CollectionItem[] = [];
  const deleted = new Set<CST.CollectionItem>();
  const indent = contribution?.indent ?? 2;
  const flow = contribution?.type === "flow-collection";

  for (const key of EXTRACTED_KINDS) {
    const previous = isMap(node) ? node.get(key, true) : undefined;
    const before: unknown[] =
      previous === undefined
        ? []
        : fields[key].unwrap().parse(previous.toJSON());
    const raw: unknown = previous?.toJSON();
    const values = extracted[key];
    if (
      previous === undefined
        ? values.length === 0
        : values.length > 0 && isDeepStrictEqual(raw, values)
    )
      continue;
    changed.push(key);
    const oldNames = names(before, key);
    const newNames = names(values, key);
    drift.push({
      key,
      added: newNames.filter((name) => !oldNames.includes(name)),
      removed: oldNames.filter((name) => !newNames.includes(name)),
    });
    const index = isMap(node)
      ? node.items.findIndex(
          (pair) => isScalar(pair.key) && pair.key.value === key,
        )
      : -1;
    const item = contribution?.items[index];
    if (!item) {
      additions.push(pairToken(key, values, indent, flow, newline));
    } else if (values.length === 0) {
      deleted.add(item);
      removedComments.push(...comments(item));
    } else {
      const sequence: YAMLSeq<unknown> = doc.createNode([...values]);
      if (isSeq(previous)) {
        sequence.flow = previous.flow;
        const replaced = previous.items.filter(
          (old) =>
            isNode(old) &&
            !sequence.items.some(
              (value) =>
                isNode(value) &&
                isDeepStrictEqual(old.toJSON(), value.toJSON()),
            ),
        );
        sequence.items = sequence.items.map((value) => {
          if (!isNode(value)) return value;
          const existing = previous.items.find(
            (old) =>
              isNode(old) && isDeepStrictEqual(old.toJSON(), value.toJSON()),
          );
          if (isNode(existing)) return existing.clone();
          // Keep comments beside a replaced item when no retained item owns them.
          const old = replaced.shift();
          if (isNode(old)) {
            value.comment = old.comment;
            value.commentBefore = old.commentBefore;
            value.spaceBefore = old.spaceBefore;
          }
          const style = previous.items.find(isScalar);
          if (isScalar(value) && style) value.type = style.type;
          return value;
        });
      }
      const rendered = new Document(sequence).toString({ lineWidth: 0 });
      const valueIndent =
        previous?.srcToken && "indent" in previous.srcToken
          ? previous.srcToken.indent
          : indent + 2;
      const source = rendered
        .split("\n")
        .map((line) => (line ? " ".repeat(valueIndent) + line : line))
        .join(newline);
      const replacement = parseDocument(source, { keepSourceTokens: true })
        .contents?.srcToken;
      if (!replacement) throw new Error("Cannot render declaration list");
      if (
        item.value?.type === "flow-collection" &&
        replacement.type === "flow-collection"
      )
        replacement.end = [
          ...replacement.end.slice(0, 1),
          ...item.value.end.slice(1),
        ];
      const oldComments = comments(item);
      item.value = replacement;
      const retained = comments(item);
      for (const comment of oldComments) {
        const found = retained.indexOf(comment);
        if (found < 0) removedComments.push(comment);
        else retained.splice(found, 1);
      }
    }
  }
  if (changed.length === 0) return { text: pluginMd, changed, drift };
  if (contribution) {
    const originalFirst = contribution.items[0];
    contribution.items = contribution.items.filter(
      (item) => !deleted.has(item),
    );
    insertPairs(contribution, additions);
    if (
      contribution.type === "block-map" &&
      contribution.items[0] !== originalFirst
    ) {
      // The parent already supplies the first line's indentation.
      const leading = contribution.items[0]?.start[0];
      if (leading?.type === "space")
        leading.source = leading.source.slice(indent);
    }
    delimiters(contribution);
    if (removedComments.length) {
      const tokens = commentTokens(removedComments, indent, newline);
      if (contribution.type === "block-map")
        contribution.items.push({ start: tokens });
      else
        contribution.end.unshift(
          { type: "newline", source: newline, indent, offset: 0 },
          ...tokens,
        );
    }
    if (
      contribution.type === "block-map" &&
      contribution.items.every((item) => !item.key)
    ) {
      // Keep comments when removing the last list; the existing mapping remains empty.
      const parent = root.items.find((item) => item.value === contribution);
      if (parent) {
        const empty = pairToken("contributes", {}, 0, false, newline);
        parent.value = empty.value;
        parent.start.unshift(
          ...commentTokens(
            [...comments(parent.sep), ...removedComments],
            0,
            newline,
          ),
        );
        parent.sep = empty.sep;
      }
    }
  } else {
    const values = Object.fromEntries(
      EXTRACTED_KINDS.filter((key) => extracted[key].length).map((key) => [
        key,
        extracted[key],
      ]),
    );
    insertPairs(root, [
      pairToken(
        "contributes",
        values,
        root.indent,
        root.type === "flow-collection",
        newline,
      ),
    ]);
    delimiters(root);
  }
  const updated = CST.stringify(root);
  const start = offset + root.offset;
  return {
    text:
      pluginMd.slice(0, start) +
      updated +
      pluginMd.slice(start + original.length),
    changed,
    drift,
  };
}
