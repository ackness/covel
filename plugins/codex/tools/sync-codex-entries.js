/**
 * Plugin-local tool: sync-codex-entries
 *
 * One call records every codex change of the turn. Each entry is matched to
 * a stored entry by title (case-insensitive): a match appends the new
 * content, merges tags, and can only raise the rarity; any other title
 * becomes a new entry. The model never handles entry ids and never chooses
 * between a create and an update call, so a guessed id cannot fail the turn.
 *
 * A new entry's key is its title as words (`codex-west-herb-garden`,
 * `codex-西侧旧药园`). Persisted values carry `categoryMeta` (icon / color)
 * from `category-metadata.js`, so the panel renders category
 * badges without a framework lookup table, and every change emits a
 * `ui-spec` EntryCard block.
 */

import {
  makeProposal,
  withPendingProposals,
  wordId,
} from "@covel/plugin-handlers-utils";

import { getCategoryMetadata } from "../category-metadata.js";

const CATEGORIES = [
  "monster",
  "item",
  "location",
  "lore",
  "character",
  "skill",
];
const RARITIES = ["common", "uncommon", "rare", "legendary"];
const MAX_NEW_ENTRIES = 3;
const MAX_TAGS = 10;

const titleKey = (title) => title.trim().toLowerCase().replace(/\s+/g, " ");
const higherRarity = (a, b) =>
  RARITIES.indexOf(b) > RARITIES.indexOf(a) ? b : a;

function mergeTags(existing, added) {
  return [...new Set([...(existing ?? []), ...(added ?? [])])].slice(
    0,
    MAX_TAGS,
  );
}

function entryCard(value, content, tags, isNew) {
  return {
    type: "ui-spec",
    entryId: value.entryId,
    spec: {
      type: "EntryCard",
      props: {
        title: value.title,
        category: value.category,
        content,
        tags,
        rarity: value.rarity,
        ...(isNew ? { isNew: true } : {}),
      },
    },
    meta: {
      entryId: value.entryId,
      category: value.category,
      title: value.title,
      rarity: value.rarity,
      imageHint: value.imageHint,
    },
  };
}

export default function ({ tool, z }) {
  const entrySchema = z.object({
    title: z
      .string()
      .min(1)
      .describe(
        "Entry title, a standalone noun phrase. A title already in the codex adds to that entry.",
      ),
    category: z
      .enum(CATEGORIES)
      .describe("Knowledge category; an existing entry keeps its own"),
    content: z
      .string()
      .min(1)
      .describe(
        "2-3 factual sentences for a new entry; only the new information for an existing one",
      ),
    tags: z
      .array(z.string().min(1))
      .max(5)
      .optional()
      .describe("2-5 noun tags"),
    rarity: z
      .enum(RARITIES)
      .optional()
      .describe(
        "Rarity (default common); on an existing entry it can only rise",
      ),
    imageHint: z
      .string()
      .optional()
      .describe("Optional visual description for later image generation"),
  });

  return tool({
    name: "sync-codex-entries",
    description: `Record every codex discovery of this turn in one call. An entry whose title is already in the codex adds to it; any other title creates a new entry (at most ${MAX_NEW_ENTRIES} per turn, extra new titles are skipped). Use runtime-done instead when nothing qualifies.`,
    parameters: z.object({
      entries: z
        .array(entrySchema)
        .min(1)
        .max(8)
        .describe("Codex changes, most important first"),
    }),
    execute: async ({ entries }, context) => {
      const now = new Date().toISOString();
      const rows = (await context.store.listPluginData("entries")) ?? [];
      /** @type {Map<string, { key: string, value: any }>} */
      const byTitle = new Map();
      const keys = new Set();
      for (const row of rows) {
        keys.add(row.key);
        if (typeof row.value?.title === "string")
          byTitle.set(titleKey(row.value.title), row);
      }

      const writes = new Map();
      const created = new Set();
      const skipped = [];
      const ui = [];
      for (const entry of entries) {
        const lookup = titleKey(entry.title);
        const existing = byTitle.get(lookup);
        let key;
        let value;
        if (existing) {
          key = existing.key;
          const prior = existing.value;
          value = {
            ...prior,
            categoryMeta: getCategoryMetadata(prior.category),
            content: `${prior.content}\n\n${entry.content}`,
            tags: mergeTags(prior.tags, entry.tags),
            rarity: higherRarity(prior.rarity ?? "common", entry.rarity),
            updatedAt: now,
            isNew: created.has(key),
          };
        } else {
          if (created.size >= MAX_NEW_ENTRIES) {
            skipped.push(entry.title);
            continue;
          }
          key = wordId("codex", entry.title, keys);
          keys.add(key);
          // Title first: the prompt's entry summaries cut values at 200
          // characters, and the model matches existing entries by title.
          value = {
            title: entry.title.trim(),
            category: entry.category,
            categoryMeta: getCategoryMetadata(entry.category),
            content: entry.content,
            tags: mergeTags([], entry.tags),
            rarity: entry.rarity ?? "common",
            imageHint: entry.imageHint,
            unlockedAt: now,
            isNew: true,
          };
          created.add(key);
        }
        // A title repeated in the batch adds to the entry just written.
        byTitle.set(lookup, { key, value });
        writes.set(key, value);
        ui.push(
          entryCard(
            { ...value, entryId: key },
            entry.content,
            entry.tags ?? [],
            !existing,
          ),
        );
      }

      // Only entries from the latest sync are new: an older entry loses the
      // marker the next time anything is recorded.
      const updatedKeys = [...writes.keys()].filter((key) => !created.has(key));
      for (const row of rows) {
        if (writes.has(row.key) || row.value?.isNew !== true) continue;
        writes.set(row.key, { ...row.value, isNew: false });
      }

      return withPendingProposals(
        {
          created: [...created],
          updated: updatedKeys,
          skipped,
          ui,
        },
        [
          makeProposal(context, now, "plugin.data.batch", {
            items: [...writes].map(([key, value]) => ({
              namespace: "entries",
              key,
              value,
            })),
          }),
        ],
      );
    },
  });
}
