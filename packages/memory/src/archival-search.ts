/**
 * Archival Memory — search of long-term knowledge, with no embedding model.
 *
 * Ranks three sources together with BM25 (`rankTexts`):
 *   - lorebook entries
 *   - character records
 *   - records of the plugin data namespaces that active plugins declared
 *     searchable (`contributes.data.<namespace>.search`)
 *
 * A plugin's other namespaces are not read: the declaration is how a plugin
 * hands data to the search, so the kernel names no plugin and reads nothing a
 * plugin did not offer.
 *
 * `createMemorySystem` puts the vector searcher in front of this one when an
 * embedding function and vector storage are present, with this searcher as its
 * fallback. Both implement {@link ArchivalSearcher}.
 */

import { rankTexts, searchExcerpt } from "@covel/plugin-handlers-utils";
import {
  characterItems,
  lorebookItems,
  pluginDataItems,
  type ArchivalItem,
  type SearchablePluginDataResolver,
} from "./archival-items.js";
import type { ArchivalStore } from "./store-contracts.js";
import type { ArchivalSearchResult, ArchivalSearcher } from "./types.js";

export function createKeywordArchivalSearcher(
  store: ArchivalStore,
  pluginData?: SearchablePluginDataResolver,
): ArchivalSearcher {
  return {
    async search(
      sessionId,
      query,
      limit = 10,
    ): Promise<readonly ArchivalSearchResult[]> {
      // One source that cannot be read does not hide the others.
      const read = (source: Promise<ArchivalItem[]>) =>
        source.catch((): ArchivalItem[] => []);
      const items = (
        await Promise.all([
          read(lorebookItems(store, sessionId)),
          read(characterItems(store, sessionId)),
          read(pluginDataItems(store, sessionId, pluginData)),
        ])
      ).flat();

      return rankTexts(
        query,
        items.map((item) => item.text),
        { limit },
      ).map(({ index, score }) => archivalResult(items[index]!, query, score));
    },
  };
}

export function archivalResult(
  item: ArchivalItem,
  query: string | undefined,
  score: number,
): ArchivalSearchResult {
  return {
    key: item.displayKey,
    content: query === undefined ? item.text : searchExcerpt(item.text, query),
    score,
    source: item.source,
    ...(item.pluginId ? { pluginId: item.pluginId } : {}),
    ...(item.namespace ? { namespace: item.namespace } : {}),
  };
}
