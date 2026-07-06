/**
 * Plugin-local tool: unlock-codex-entries
 *
 * Batch unlock multiple codex entries in one call.
 * Persists to plugin-data store and produces a rich "discovery" UI card.
 *
 * Uses shortIdBatch() to generate LLM-friendly IDs like 'codex-fire-magic'
 * instead of UUID-based IDs. LLM can reference these IDs in update-codex-entry.
 *
 * Each persisted entry's `value` is enriched with a `categoryMeta` field
 * (icon / color / displayName) sourced from the plugin-local
 * `category-metadata.js`. This lets the UI (json-render spec) render
 * category badges without any framework-side lookup table.
 *
 * UI output: each unlocked entry emits a `ui-spec` block whose `spec` is a
 * self-contained json-render nested tree rendering an EntryCard. The
 * framework/web renderer stays plugin-agnostic — it only needs to know the
 * generic `ui-spec` convention, not anything about codex semantics.
 */

import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";
import { getCategoryMetadata } from "../category-metadata.js";

export default function ({ tool, z, shortIdBatch, store }) {
  const codexEntrySchema = z.object({
    category: z
      .enum(["monster", "item", "location", "lore", "character", "skill"])
      .describe("Knowledge category"),
    title: z.string().min(1).describe("Entry title"),
    content: z.string().min(10).describe("A 2-3 sentence description"),
    tags: z.array(z.string()).min(1).max(5).describe("List of tags"),
    rarity: z
      .enum(["common", "uncommon", "rare", "legendary"])
      .default("common")
      .describe("Rarity; affects the UI display style"),
    imageHint: z
      .string()
      .optional()
      .describe("Optional visual description hint for later image generation"),
  });

  return tool({
    name: "unlock-codex-entries",
    description:
      'Batch-unlock new codex entries. Entries are persisted and rendered as a "knowledge discovery" card. The returned entryId (e.g. codex-fire-magic) can be used in subsequent update-codex-entry calls.',
    parameters: z.object({
      entries: z
        .array(codexEntrySchema)
        .min(1)
        .describe("List of codex entries to unlock"),
    }),
    execute: async (params, context) => {
      const ids = shortIdBatch(
        "codex",
        params.entries.map((e) => e.title),
        context.sessionId,
      );
      const now = new Date().toISOString();

      const results = params.entries.map((entry, i) => ({
        entryId: ids[i],
        ...entry,
        unlockedAt: now,
      }));

      // Persist all entries to plugin-data store. The persisted `value`
      // self-describes its category via `categoryMeta` so the UI doesn't
      // need a framework-side category lookup table.
      //
      // `isNew: true` flags a fresh unlock so the UI can decorate the card
      // (generic EntryCard prop). This panel keeps the NEW badge on
      // indefinitely — there is no session-scoped "clear NEW" mechanism
      // yet; downstream plugins can extend this if needed.
      const items = results.map((entry) => ({
        namespace: "entries",
        key: entry.entryId,
        value: {
          category: entry.category,
          categoryMeta: getCategoryMetadata(entry.category),
          title: entry.title,
          content: entry.content,
          tags: entry.tags,
          rarity: entry.rarity,
          imageHint: entry.imageHint,
          unlockedAt: entry.unlockedAt,
          isNew: true,
        },
      }));
      const ui = results.map((entry) => ({
        type: "ui-spec",
        entryId: entry.entryId,
        spec: {
          type: "EntryCard",
          props: {
            title: entry.title,
            category: entry.category,
            content: entry.content,
            tags: entry.tags,
            rarity: entry.rarity,
            isNew: true,
          },
        },
        // Keep raw payload alongside the spec so downstream debug tooling
        // (raw JSON view, trace exports) can still see the source data.
        meta: {
          entryId: entry.entryId,
          category: entry.category,
          title: entry.title,
          rarity: entry.rarity,
          imageHint: entry.imageHint,
        },
      }));

      return withPendingProposals(
        {
          unlocked: results.length,
          entries: results,
          ui,
        },
        [makeProposal(context, now, "plugin.data.batch", { items })],
      );
    },
  });
}
