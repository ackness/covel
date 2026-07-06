/**
 * Proposal-specific commit handlers.
 *
 * The handler registry is keyed by `ProposalType` via `CommitHandlerMap`, so
 * adding a proposal type to `ProposalPayloadMap` (in @covel/shared) forces a
 * matching handler here — a missing handler is a compile error, never a
 * silent `unknown proposal type` failure at runtime. Each handler receives a
 * `ProposalFor<K>`, so `proposal.payload` is already the precise payload type
 * (no `as XxxPayload` casts required).
 */

import { assetGenerateToView, isAssetGeneratePayload } from "@covel/shared";
import type {
  CommitResult,
  Proposal,
  ProposalFor,
  ProposalType,
} from "@covel/shared";
import type { KernelStore } from "../session/session-kernel-store.js";
import {
  makeEvent,
  resolveBlockType,
} from "../session/session-kernel-helpers.js";
import {
  commitError,
  firstFailure,
  requireNonEmptyArray,
  requireNonEmptyString,
  requireOptionalNumber,
  requireOptionalString,
  requireOptionalStringArray,
} from "./commit-validators.js";

/** A commit handler narrowed to a single proposal type. */
export type CommitHandlerFor<K extends ProposalType> = (
  proposal: ProposalFor<K>,
) => Promise<CommitResult>;

/**
 * Exhaustive registry shape: every `ProposalType` must have a handler.
 * `createCommitHandlers` returns this type, so omitting a handler fails to
 * compile.
 */
export type CommitHandlerMap = {
  [K in ProposalType]: CommitHandlerFor<K>;
};

/**
 * Type-erased handler used at the dispatch site. The pipeline looks a handler
 * up by `proposal.type` and invokes it with the full `Proposal` union; this is
 * the canonical correlated-union escape hatch (a single cast in the pipeline,
 * never inside individual handlers).
 */
export type CommitHandler = (proposal: Proposal) => Promise<CommitResult>;

export function createCommitHandlers(store: KernelStore): CommitHandlerMap {
  return {
    "narrative.append": commitNarrative,
    "interaction.request": commitInteraction,
    "ui.render": commitUIRender,
    "state.patch": commitStatePatch,
    "event.emit": commitEvent,
    "plugin.data": commitPluginData,
    "plugin.data.batch": commitPluginDataBatch,
    "character.upsert": commitCharacterUpsert,
    "working_memory.set": commitWorkingMemory,
    "lorebook.upsert": commitLorebookUpsert,
    "asset.generate": commitAssetGenerate,
  };

  async function commitNarrative(
    proposal: ProposalFor<"narrative.append">,
  ): Promise<CommitResult> {
    const { content, kind } = proposal.payload;
    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: kind === "system" ? "system" : "assistant",
      content,
      metadata: {
        turnId: proposal.turnId,
        runtimeId: proposal.source.runtimeId,
        kind,
      },
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("narrative.completed", proposal, {
        content,
        kind,
        messageId: proposal.id,
      }),
    };
  }

  async function commitInteraction(
    proposal: ProposalFor<"interaction.request">,
  ): Promise<CommitResult> {
    const payload = { ...proposal.payload };
    const block = {
      id: proposal.id,
      type: resolveBlockType(payload),
      data: payload,
      meta: {
        runtimeId: proposal.source.runtimeId,
        pluginId: proposal.source.pluginId,
        turnId: proposal.turnId,
      },
    };
    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: "assistant",
      content: "",
      metadata: {
        turnId: proposal.turnId,
        runtimeId: proposal.source.runtimeId,
        kind: "plugin",
        block,
      },
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("interaction.requested", proposal, {
        ...payload,
        block,
      }),
    };
  }

  async function commitUIRender(
    proposal: ProposalFor<"ui.render">,
  ): Promise<CommitResult> {
    const payload = proposal.payload;
    const invalid = requireNonEmptyArray(
      payload.parts,
      "ui.render: parts must be a non-empty array",
    );
    if (invalid) return invalid;

    const block = {
      id: proposal.id,
      type: "ui.render",
      data: payload,
      meta: {
        runtimeId: proposal.source.runtimeId,
        pluginId: proposal.source.pluginId,
        turnId: proposal.turnId,
      },
    };

    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: "assistant",
      content: "",
      metadata: {
        turnId: proposal.turnId,
        runtimeId: proposal.source.runtimeId,
        kind: "plugin",
        block,
      },
      createdAt: proposal.timestamp,
    });

    return {
      committed: true,
      event: makeEvent("ui.rendered", proposal, { render: payload, block }),
    };
  }

  async function commitStatePatch(
    proposal: ProposalFor<"state.patch">,
  ): Promise<CommitResult> {
    const { table, field, value } = proposal.payload;
    // The payload types require table/field, but .js plugins bypass the type
    // layer and the output normalizer passes state.patch through untouched —
    // without this gate a malformed patch silently landed in "default"/"unknown".
    const invalid = firstFailure(
      requireNonEmptyString(
        table,
        "state.patch: table must be a non-empty string",
      ),
      requireNonEmptyString(
        field,
        "state.patch: field must be a non-empty string",
      ),
    );
    if (invalid) return invalid;
    // Update the current value AND append the change log, mirroring
    // StateManager.setValue. Without the upsertStateEntry, a committed
    // state.patch never changed the value that listStateEntries /
    // getTableSnapshot / fork snapshots read — the write was lost to every
    // current-value reader.
    await store.upsertStateEntry({
      id: crypto.randomUUID(),
      sessionId: proposal.sessionId,
      tableName: table,
      fieldName: field,
      value,
      updatedAt: proposal.timestamp,
    });
    await store.addStateChange({
      id: proposal.id,
      sessionId: proposal.sessionId,
      tableName: table,
      fieldName: field,
      value,
      changedBy: `${proposal.source.pluginId}/${proposal.source.runtimeId}`,
      turnId: proposal.turnId,
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("state.changed", proposal, { ...proposal.payload }),
    };
  }

  async function commitEvent(
    proposal: ProposalFor<"event.emit">,
  ): Promise<CommitResult> {
    const { topic, data } = proposal.payload;
    const invalid = requireNonEmptyString(
      topic,
      "event.emit: topic must be a non-empty string",
    );
    if (invalid) return invalid;
    await store.saveEvent({
      id: proposal.id,
      sessionId: proposal.sessionId,
      type: "game",
      topic,
      payload: data ?? {},
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("event.emitted", proposal, { ...proposal.payload }),
    };
  }

  async function commitAssetGenerate(
    proposal: ProposalFor<"asset.generate">,
  ): Promise<CommitResult> {
    if (!isAssetGeneratePayload(proposal.payload)) {
      return commitError(
        "asset.generate: payload must be { ref: MediaRef, modality: string, meta?: object }",
      );
    }

    const view = assetGenerateToView(proposal);
    const block = {
      id: proposal.id,
      type: "asset.generate",
      data: view,
      meta: {
        runtimeId: proposal.source.runtimeId,
        pluginId: proposal.source.pluginId,
        turnId: proposal.turnId,
      },
    };

    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: "assistant",
      content: "",
      metadata: {
        turnId: proposal.turnId,
        runtimeId: proposal.source.runtimeId,
        kind: "plugin",
        block,
      },
      createdAt: proposal.timestamp,
    });

    return {
      committed: true,
      event: makeEvent("asset.generated", proposal, { asset: view, block }),
    };
  }

  async function commitPluginData(
    proposal: ProposalFor<"plugin.data">,
  ): Promise<CommitResult> {
    const payload = proposal.payload;
    const setPluginData = store.setPluginData;
    if (!setPluginData) {
      return commitError(
        "plugin.data: store does not support plugin data writes",
      );
    }
    const invalid = firstFailure(
      requireNonEmptyString(
        payload.namespace,
        "plugin.data: namespace must be a non-empty string",
      ),
      requireNonEmptyString(
        payload.key,
        "plugin.data: key must be a non-empty string",
      ),
    );
    if (invalid) return invalid;

    await setPluginData({
      id: crypto.randomUUID(),
      sessionId: proposal.sessionId,
      pluginId: proposal.source.pluginId,
      namespace: payload.namespace,
      key: payload.key,
      value: payload.value,
      createdAt: proposal.timestamp,
      updatedAt: proposal.timestamp,
    });

    return { committed: true };
  }

  async function commitPluginDataBatch(
    proposal: ProposalFor<"plugin.data.batch">,
  ): Promise<CommitResult> {
    const payload = proposal.payload;
    const setPluginDataBatch = store.setPluginDataBatch;
    if (!setPluginDataBatch) {
      return commitError(
        "plugin.data.batch: store does not support plugin data writes",
      );
    }
    const invalid = firstFailure(
      requireNonEmptyArray(
        payload.items,
        "plugin.data.batch: items must be a non-empty array",
      ),
    );
    if (invalid) return invalid;

    const records = [];
    for (const item of payload.items) {
      const itemInvalid = firstFailure(
        requireNonEmptyString(
          item.namespace,
          "plugin.data.batch: every item needs a non-empty namespace",
        ),
        requireNonEmptyString(
          item.key,
          "plugin.data.batch: every item needs a non-empty key",
        ),
      );
      if (itemInvalid) return itemInvalid;
      records.push({
        id: crypto.randomUUID(),
        sessionId: proposal.sessionId,
        pluginId: proposal.source.pluginId,
        namespace: item.namespace,
        key: item.key,
        value: item.value,
        createdAt: proposal.timestamp,
        updatedAt: proposal.timestamp,
      });
    }

    await setPluginDataBatch(records);
    return { committed: true };
  }

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
    const record = {
      id: payload.id,
      sessionId: proposal.sessionId,
      name: payload.name,
      type: payload.type ?? "npc",
      ...(payload.description !== undefined
        ? { description: payload.description }
        : {}),
      ...(payload.fields !== undefined ? { fields: payload.fields } : {}),
      version: payload.version ?? 1,
      createdAt: payload.createdAt ?? now,
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

  async function commitWorkingMemory(
    proposal: ProposalFor<"working_memory.set">,
  ): Promise<CommitResult> {
    const payload = proposal.payload;

    const validScopes = new Set(["player", "story", "shared"]);
    const scopeInvalid =
      typeof payload.scope !== "string" || !validScopes.has(payload.scope)
        ? commitError(
            `working_memory.set: invalid scope "${String(payload.scope)}"`,
          )
        : undefined;
    const invalid = firstFailure(
      scopeInvalid,
      requireNonEmptyString(
        payload.key,
        "working_memory.set: key must be a non-empty string",
      ),
      payload.value === undefined
        ? commitError("working_memory.set: value must not be undefined")
        : undefined,
      // TODO(S3-T3.b): resolve schemaRef against a framework-level Zod schema
      // registry (A9 refinement) and validate payload.value against the schema.
      // For now, schemaRef is accepted as an opaque string.
      requireOptionalString(
        payload.schemaRef,
        "working_memory.set: schemaRef must be a string when provided",
      ),
    );
    if (invalid) return invalid;

    const upsertWorkingMemory = store.upsertWorkingMemory;
    if (!upsertWorkingMemory) {
      return commitError(
        "working_memory.set: store does not support working memory",
      );
    }

    const { scope, key } = payload;
    await upsertWorkingMemory({
      id: crypto.randomUUID(),
      sessionId: proposal.sessionId,
      key,
      scope,
      value: payload.value,
      schemaRef: payload.schemaRef,
      updatedAt: new Date().toISOString(),
    });

    // Emit working_memory.changed session event so subscribers can react
    const wmEvent = makeEvent("working_memory.changed", proposal, {
      scope,
      key,
    });

    return { committed: true, event: wmEvent };
  }

  async function commitLorebookUpsert(
    proposal: ProposalFor<"lorebook.upsert">,
  ): Promise<CommitResult> {
    const payload = proposal.payload;
    const invalid = firstFailure(
      requireNonEmptyArray(
        payload.entries,
        "lorebook.upsert: entries must be a non-empty array",
      ),
    );
    if (invalid) return invalid;

    const upsertLorebookEntries = store.upsertLorebookEntries;
    if (!upsertLorebookEntries) {
      return commitError(
        "lorebook.upsert: store does not support session lorebook entries",
      );
    }

    const now = new Date().toISOString();
    const records: Array<{
      id: string;
      sessionId: string;
      pluginId: string;
      keys: readonly string[];
      content: string;
      strategy: "constant" | "selective";
      position: string;
      insertionOrder: number;
      enabled: boolean;
      extra?: unknown;
      createdAt: string;
      updatedAt: string;
    }> = [];

    // Entries may arrive from untyped (.js) plugin tools, so each field is
    // validated defensively rather than trusting the declared payload type.
    for (const raw of payload.entries as readonly unknown[]) {
      const entry = raw as Record<string, unknown>;
      const idInvalid = requireNonEmptyString(
        entry.id,
        "lorebook.upsert: each entry needs a non-empty id",
      );
      if (idInvalid) return idInvalid;
      if (typeof entry.content !== "string") {
        return commitError(
          `lorebook.upsert: entry ${entry.id} missing content`,
        );
      }
      if (entry.strategy !== "constant" && entry.strategy !== "selective") {
        return commitError(
          `lorebook.upsert: entry ${entry.id} has invalid strategy`,
        );
      }
      const keys = Array.isArray(entry.keys)
        ? (entry.keys as unknown[]).filter(
            (k): k is string => typeof k === "string",
          )
        : [];
      records.push({
        id: entry.id as string,
        sessionId: proposal.sessionId,
        pluginId: proposal.source.pluginId,
        keys,
        content: entry.content,
        strategy: entry.strategy,
        position:
          typeof entry.position === "string"
            ? entry.position
            : "after_char_defs",
        insertionOrder:
          typeof entry.insertionOrder === "number" ? entry.insertionOrder : 100,
        enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
        extra: entry.extra,
        createdAt: now,
        updatedAt: now,
      });
    }

    await upsertLorebookEntries(records);

    return { committed: true };
  }
}
