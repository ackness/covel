/**
 * Proposal-specific commit handlers — composition root.
 *
 * Handlers live in per-domain modules (commit-narrative / commit-ui /
 * commit-state / commit-event / commit-plugin-data / commit-character /
 * commit-memory-lore); each exports a factory taking the store and returning
 * a typed `Pick<CommitHandlerMap, ...>` slice. This module composes them into
 * the exhaustive registry: adding a proposal type to `ProposalPayloadMap`
 * (in @covel/shared) makes the return-type check below fail to compile until
 * a domain module supplies the matching handler — never a silent
 * `unknown proposal type` failure at runtime.
 */

import type { KernelStore } from "../session/session-kernel-store.js";
import { createCharacterCommitHandlers } from "./commit-character.js";
import { createEventCommitHandlers } from "./commit-event.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import { createMemoryLoreCommitHandlers } from "./commit-memory-lore.js";
import { createNarrativeCommitHandlers } from "./commit-narrative.js";
import { createPluginDataCommitHandlers } from "./commit-plugin-data.js";
import { createStateCommitHandlers } from "./commit-state.js";
import { createUiCommitHandlers } from "./commit-ui.js";

export type {
  CommitHandler,
  CommitHandlerFor,
  CommitHandlerMap,
} from "./commit-handler-types.js";

export function createCommitHandlers(store: KernelStore): CommitHandlerMap {
  return {
    ...createNarrativeCommitHandlers(store),
    ...createUiCommitHandlers(store),
    ...createStateCommitHandlers(store),
    ...createEventCommitHandlers(store),
    ...createPluginDataCommitHandlers(store),
    ...createCharacterCommitHandlers(store),
    ...createMemoryLoreCommitHandlers(store),
  };
}
