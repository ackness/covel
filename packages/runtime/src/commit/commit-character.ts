/**
 * Commit handler for `character.upsert` — persists the CharacterRecord and
 * mirrors a snapshot into the requesting plugins' `characters` namespaces.
 */

import type { CommitResult, ProposalFor } from "@covel/shared";
import { makeEvent } from "../session/session-kernel-helpers.js";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import {
  commitError,
  firstFailure,
  requireNonEmptyString,
  requireOptionalNumber,
  requireOptionalString,
  requireOptionalStringArray,
} from "./commit-validators.js";

export function createCharacterCommitHandlers(
  store: KernelStore,
): Pick<CommitHandlerMap, "character.upsert"> {
  async function commitCharacterUpsert(
    proposal: ProposalFor<"character.upsert">,
  ): Promise<CommitResult> {
    const payload = proposal.payload;
    const upsertCharacter = store.upsertCharacter;
    if (!upsertCharacter) {
      return commitError(
        "character.upsert: store does not support character writes",
      );
    }
    const invalid = firstFailure(
      requireNonEmptyString(
        payload.id,
        "character.upsert: id must be a non-empty string",
      ),
      requireNonEmptyString(
        payload.name,
        "character.upsert: name must be a non-empty string",
      ),
      requireOptionalString(
        payload.type,
        "character.upsert: type must be a string when provided",
      ),
      requireOptionalString(
        payload.description,
        "character.upsert: description must be a string when provided",
      ),
      requireOptionalNumber(
        payload.version,
        "character.upsert: version must be a number when provided",
      ),
      requireOptionalNumber(
        payload.expectedVersion,
        "character.upsert: expectedVersion must be a number when provided",
      ),
      requireOptionalString(
        payload.createdAt,
        "character.upsert: createdAt must be a string when provided",
      ),
      requireOptionalString(
        payload.mirrorPluginId,
        "character.upsert: mirrorPluginId must be a string when provided",
      ),
      requireOptionalStringArray(
        payload.mirrorPluginIds,
        "character.upsert: mirrorPluginIds must be a string array when provided",
      ),
    );
    if (invalid) return invalid;

    const now = new Date().toISOString();
    const versionedUpdate = payload.expectedVersion !== undefined;
    const live = versionedUpdate
      ? (await store.listCharacters?.(proposal.sessionId))?.find(
          (character) => character.id === payload.id,
        )
      : undefined;
    if (versionedUpdate && !store.listCharacters) {
      return commitError(
        "character.upsert: store does not support versioned character updates",
      );
    }
    if (versionedUpdate && !live) {
      return commitError(
        `character.upsert: character ${payload.id} no longer exists`,
      );
    }
    if (
      live &&
      (payload.expectedVersion! < 1 ||
        payload.expectedVersion! > live.version ||
        !Number.isInteger(payload.expectedVersion))
    ) {
      return commitError(
        `character.upsert: expectedVersion ${payload.expectedVersion} is invalid for live version ${live.version}`,
      );
    }

    const liveFields = asFieldsRecord(live?.fields);
    const fieldPatch = asFieldsRecord(payload.fields);
    const rebasedFields = live
      ? payload.fields === undefined
        ? live.fields
        : liveFields && fieldPatch
          ? { ...liveFields, ...fieldPatch }
          : payload.fields
      : payload.fields;
    const record = {
      id: payload.id,
      sessionId: proposal.sessionId,
      name: live?.name ?? payload.name,
      type: live?.type ?? payload.type ?? "npc",
      ...(payload.description !== undefined || live?.description !== undefined
        ? { description: payload.description ?? live?.description }
        : {}),
      ...(rebasedFields !== undefined ? { fields: rebasedFields } : {}),
      version: live ? live.version + 1 : (payload.version ?? 1),
      createdAt: live?.createdAt ?? payload.createdAt ?? now,
      updatedAt: now,
    };

    await upsertCharacter(record);

    const setPluginData = store.setPluginData;
    if (setPluginData) {
      const mirrorPluginIds = [
        ...(payload.mirrorPluginId ? [payload.mirrorPluginId] : []),
        ...(payload.mirrorPluginIds ?? []),
      ].filter((pluginId, index, all) => all.indexOf(pluginId) === index);
      // Each (sessionId, pluginId, namespace, key) target is independent.
      await Promise.all(
        mirrorPluginIds.map((mirrorPluginId) =>
          setPluginData({
            id: crypto.randomUUID(),
            sessionId: proposal.sessionId,
            pluginId: mirrorPluginId,
            namespace: "characters",
            key: record.id,
            value: {
              id: record.id,
              name: record.name,
              type: record.type,
              ...(record.description !== undefined
                ? { description: record.description }
                : {}),
              ...(record.fields !== undefined ? { fields: record.fields } : {}),
              version: record.version,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            },
            createdAt: proposal.timestamp,
            updatedAt: now,
          }),
        ),
      );
    }

    return {
      committed: true,
      event: makeEvent("character.upserted", proposal, { character: record }),
    };
  }

  return { "character.upsert": commitCharacterUpsert };
}

function asFieldsRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
