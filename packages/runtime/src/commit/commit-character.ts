/** Commit world records through the same validation used by execution views. */
import {
  materializeWorldModel,
  type CharacterRecord,
  type CharacterSchemaRecord,
  type CommitResult,
  type ProposalFor,
} from "@covel/shared";
import { makeEvent } from "../session/session-kernel-helpers.js";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import { commitError } from "./commit-validators.js";

export interface CharacterCommitOptions {
  /**
   * The handlers serve one batch that nothing else writes characters during.
   * They then read a session's characters and schema once and keep the view
   * current from their own writes, instead of reading every character again
   * for each record. The view dies with the handlers, so a rolled-back batch
   * leaves nothing behind.
   */
  readonly singleBatch?: boolean;
}

interface WorldRecords {
  characters: readonly CharacterRecord[];
  characterSchema: CharacterSchemaRecord | null;
}

export function createCharacterCommitHandlers(
  store: KernelStore,
  options: CharacterCommitOptions = {},
): Pick<CommitHandlerMap, "character.upsert" | "character.schema.set"> {
  const batchViews = new Map<string, WorldRecords>();
  async function readWorldRecords(sessionId: string): Promise<WorldRecords> {
    const held = batchViews.get(sessionId);
    if (held) return held;
    const [characters, characterSchema] = await Promise.all([
      store.listCharacters!(sessionId),
      store.getCharacterSchema?.(sessionId) ?? null,
    ]);
    const records = { characters, characterSchema } as WorldRecords;
    if (options.singleBatch) batchViews.set(sessionId, records);
    return records;
  }
  async function commitWorldRecord(
    proposal:
      ProposalFor<"character.upsert"> | ProposalFor<"character.schema.set">,
  ): Promise<CommitResult> {
    if (!store.listCharacters)
      return commitError(
        `${proposal.type}: store does not support character reads`,
      );
    if (proposal.type === "character.upsert" && !store.upsertCharacter)
      return commitError(
        "character.upsert: store does not support character writes",
      );
    if (
      proposal.type === "character.schema.set" &&
      (!store.upsertCharacterSchema || !store.getCharacterSchema)
    )
      return commitError(
        "character.schema.set: store does not support schema writes",
      );
    const records = await readWorldRecords(proposal.sessionId);
    let view;
    try {
      view = materializeWorldModel(records, [proposal], proposal.sessionId);
    } catch (error) {
      return commitError(
        `${proposal.type}: ${error instanceof Error ? error.message : "Invalid world record"}`,
      );
    }
    if (proposal.type === "character.schema.set") {
      const schema = view.characterSchema!;
      await store.upsertCharacterSchema!(schema);
      records.characterSchema = schema;
      return {
        committed: true,
        event: makeEvent("character-schema.changed", proposal, { schema }),
      };
    }
    const character = view.characters.find(
      (record) => record.id === proposal.payload.id,
    )!;
    await store.upsertCharacter!(character);
    // The next record of the batch is checked against this write: a name or
    // alias taken here is taken, one given up here is free.
    records.characters = view.characters;
    return {
      committed: true,
      event: makeEvent("character.upserted", proposal, { character }),
    };
  }
  return {
    "character.upsert": commitWorldRecord,
    "character.schema.set": commitWorldRecord,
  };
}
