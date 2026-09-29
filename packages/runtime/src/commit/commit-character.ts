/** Commit world records through the same validation used by execution views. */
import {
  materializeWorldModel,
  type CommitResult,
  type ProposalFor,
} from "@covel/shared";
import { makeEvent } from "../session/session-kernel-helpers.js";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import { commitError } from "./commit-validators.js";

export function createCharacterCommitHandlers(
  store: KernelStore,
): Pick<CommitHandlerMap, "character.upsert" | "character.schema.set"> {
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
    const [characters, characterSchema] = await Promise.all([
      store.listCharacters(proposal.sessionId),
      store.getCharacterSchema?.(proposal.sessionId) ?? null,
    ]);
    let view;
    try {
      view = materializeWorldModel(
        { characters, characterSchema },
        [proposal],
        proposal.sessionId,
      );
    } catch (error) {
      return commitError(
        `${proposal.type}: ${error instanceof Error ? error.message : "Invalid world record"}`,
      );
    }
    if (proposal.type === "character.schema.set") {
      const schema = view.characterSchema!;
      await store.upsertCharacterSchema!(schema);
      return {
        committed: true,
        event: makeEvent("character-schema.changed", proposal, { schema }),
      };
    }
    const character = view.characters.find(
      (record) => record.id === proposal.payload.id,
    )!;
    await store.upsertCharacter!(character);
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
