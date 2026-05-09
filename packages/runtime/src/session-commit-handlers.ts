/**
 * Proposal-specific commit handlers.
 */

import {
  assetGenerateToView,
  isAssetGeneratePayload,
  isEnvEnabled,
} from "@covel/shared";
import type {
  CharacterUpsertPayload,
  CommitResult,
  PluginDataBatchPayload,
  PluginDataPayload,
  Proposal,
  UIRenderPayload,
} from "@covel/shared";
import type { KernelStore } from "./session-kernel-store.js";
import { makeEvent, resolveBlockType } from "./session-kernel-helpers.js";

export type CommitHandler = (proposal: Proposal) => Promise<CommitResult>;

export function createCommitHandlers(
  store: KernelStore,
): Record<string, CommitHandler> {
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

  async function commitNarrative(proposal: Proposal): Promise<CommitResult> {
    const { content, kind } = proposal.payload as {
      content: string;
      kind: string;
    };
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

  async function commitInteraction(proposal: Proposal): Promise<CommitResult> {
    const payload = proposal.payload as Record<string, unknown>;
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

  async function commitUIRender(proposal: Proposal): Promise<CommitResult> {
    const payload = proposal.payload as unknown as UIRenderPayload;
    if (!Array.isArray(payload.parts) || payload.parts.length === 0) {
      return {
        committed: false,
        error: "ui.render: parts must be a non-empty array",
      };
    }

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

  async function commitStatePatch(proposal: Proposal): Promise<CommitResult> {
    const { table, field, value } = proposal.payload as {
      table: string;
      field: string;
      value: unknown;
    };
    await store.addStateChange({
      id: proposal.id,
      sessionId: proposal.sessionId,
      tableName: table ?? "default",
      fieldName: field ?? "unknown",
      value,
      changedBy: `${proposal.source.pluginId}/${proposal.source.runtimeId}`,
      turnId: proposal.turnId,
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("state.changed", proposal, proposal.payload),
    };
  }

  async function commitEvent(proposal: Proposal): Promise<CommitResult> {
    const { topic, data } = proposal.payload as {
      topic: string;
      data: Record<string, unknown>;
    };
    await store.saveEvent({
      id: proposal.id,
      sessionId: proposal.sessionId,
      type: "game",
      topic: topic ?? "unknown",
      payload: data ?? {},
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("event.emitted", proposal, proposal.payload),
    };
  }

  async function commitAssetGenerate(
    proposal: Proposal,
  ): Promise<CommitResult> {
    if (!isAssetGeneratePayload(proposal.payload)) {
      return {
        committed: false,
        error:
          "asset.generate: payload must be { ref: MediaRef, modality: string, meta?: object }",
      };
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

  async function commitPluginData(proposal: Proposal): Promise<CommitResult> {
    if (!store.setPluginData) {
      return {
        committed: false,
        error: "plugin.data: store does not support plugin data writes",
      };
    }

    const payload = proposal.payload as unknown as PluginDataPayload;
    if (
      typeof payload.namespace !== "string" ||
      payload.namespace.length === 0
    ) {
      return {
        committed: false,
        error: "plugin.data: namespace must be a non-empty string",
      };
    }
    if (typeof payload.key !== "string" || payload.key.length === 0) {
      return {
        committed: false,
        error: "plugin.data: key must be a non-empty string",
      };
    }

    await store.setPluginData({
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
    proposal: Proposal,
  ): Promise<CommitResult> {
    if (!store.setPluginDataBatch) {
      return {
        committed: false,
        error: "plugin.data.batch: store does not support plugin data writes",
      };
    }

    const payload = proposal.payload as unknown as PluginDataBatchPayload;
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      return {
        committed: false,
        error: "plugin.data.batch: items must be a non-empty array",
      };
    }

    const records = [];
    for (const item of payload.items) {
      if (typeof item.namespace !== "string" || item.namespace.length === 0) {
        return {
          committed: false,
          error: "plugin.data.batch: every item needs a non-empty namespace",
        };
      }
      if (typeof item.key !== "string" || item.key.length === 0) {
        return {
          committed: false,
          error: "plugin.data.batch: every item needs a non-empty key",
        };
      }
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

    await store.setPluginDataBatch(records);
    return { committed: true };
  }

  async function commitCharacterUpsert(
    proposal: Proposal,
  ): Promise<CommitResult> {
    if (!store.upsertCharacter) {
      return {
        committed: false,
        error: "character.upsert: store does not support character writes",
      };
    }

    const payload = proposal.payload as unknown as CharacterUpsertPayload;
    if (typeof payload.id !== "string" || payload.id.length === 0) {
      return {
        committed: false,
        error: "character.upsert: id must be a non-empty string",
      };
    }
    if (typeof payload.name !== "string" || payload.name.length === 0) {
      return {
        committed: false,
        error: "character.upsert: name must be a non-empty string",
      };
    }
    if (payload.type !== undefined && typeof payload.type !== "string") {
      return {
        committed: false,
        error: "character.upsert: type must be a string when provided",
      };
    }
    if (
      payload.description !== undefined &&
      typeof payload.description !== "string"
    ) {
      return {
        committed: false,
        error: "character.upsert: description must be a string when provided",
      };
    }
    if (payload.version !== undefined && typeof payload.version !== "number") {
      return {
        committed: false,
        error: "character.upsert: version must be a number when provided",
      };
    }
    if (
      payload.createdAt !== undefined &&
      typeof payload.createdAt !== "string"
    ) {
      return {
        committed: false,
        error: "character.upsert: createdAt must be a string when provided",
      };
    }
    if (
      payload.mirrorPluginId !== undefined &&
      typeof payload.mirrorPluginId !== "string"
    ) {
      return {
        committed: false,
        error:
          "character.upsert: mirrorPluginId must be a string when provided",
      };
    }
    if (
      payload.mirrorPluginIds !== undefined &&
      (!Array.isArray(payload.mirrorPluginIds) ||
        payload.mirrorPluginIds.some((id) => typeof id !== "string"))
    ) {
      return {
        committed: false,
        error:
          "character.upsert: mirrorPluginIds must be a string array when provided",
      };
    }

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

    await store.upsertCharacter(record);

    if (store.setPluginData) {
      const mirrorPluginIds = [
        ...(payload.mirrorPluginId ? [payload.mirrorPluginId] : []),
        ...(payload.mirrorPluginIds ?? []),
      ].filter((pluginId, index, all) => all.indexOf(pluginId) === index);
      for (const mirrorPluginId of mirrorPluginIds) {
        await store.setPluginData({
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
        });
      }
    }

    return {
      committed: true,
      event: makeEvent("character.upserted", proposal, { character: record }),
    };
  }

  async function commitWorkingMemory(
    proposal: Proposal,
  ): Promise<CommitResult> {
    // Feature-flag gate: reject when COVEL_WORKING_MEMORY_V1 is not enabled.
    if (!isEnvEnabled("COVEL_WORKING_MEMORY_V1")) {
      return { committed: false, error: "working_memory disabled" };
    }

    const payload = proposal.payload as {
      scope?: unknown;
      key?: unknown;
      value?: unknown;
      schemaRef?: unknown;
    };

    const validScopes = new Set(["player", "story", "shared"]);
    if (typeof payload.scope !== "string" || !validScopes.has(payload.scope)) {
      return {
        committed: false,
        error: `working_memory.set: invalid scope "${String(payload.scope)}"`,
      };
    }
    if (typeof payload.key !== "string" || payload.key.length === 0) {
      return {
        committed: false,
        error: "working_memory.set: key must be a non-empty string",
      };
    }
    if (payload.value === undefined) {
      return {
        committed: false,
        error: "working_memory.set: value must not be undefined",
      };
    }
    if (
      payload.schemaRef !== undefined &&
      typeof payload.schemaRef !== "string"
    ) {
      return {
        committed: false,
        error: "working_memory.set: schemaRef must be a string when provided",
      };
    }

    // TODO(S3-T3.b): resolve schemaRef against a framework-level Zod schema
    // registry (A9 refinement) and validate payload.value against the schema.
    // For now, schemaRef is accepted as an opaque string.

    if (!store.upsertWorkingMemory) {
      return {
        committed: false,
        error: "working_memory.set: store does not support working memory",
      };
    }

    const scope = payload.scope as "player" | "story" | "shared";
    await store.upsertWorkingMemory({
      id: crypto.randomUUID(),
      sessionId: proposal.sessionId,
      key: payload.key,
      scope,
      value: payload.value,
      schemaRef: payload.schemaRef as string | undefined,
      updatedAt: new Date().toISOString(),
    });

    // Emit working_memory.changed session event so subscribers can react
    const wmEvent = makeEvent("working_memory.changed", proposal, {
      scope,
      key: payload.key,
    });

    return { committed: true, event: wmEvent };
  }

  async function commitLorebookUpsert(
    proposal: Proposal,
  ): Promise<CommitResult> {
    // The lorebook core itself is always on — only the session-scoped write
    // path is gated so plugins authored for earlier versions keep working.
    const payload = proposal.payload as { entries?: unknown };
    if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
      return {
        committed: false,
        error: "lorebook.upsert: entries must be a non-empty array",
      };
    }

    if (!store.upsertLorebookEntries) {
      return {
        committed: false,
        error:
          "lorebook.upsert: store does not support session lorebook entries",
      };
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

    for (const raw of payload.entries) {
      const entry = raw as Record<string, unknown>;
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        return {
          committed: false,
          error: "lorebook.upsert: each entry needs a non-empty id",
        };
      }
      if (typeof entry.content !== "string") {
        return {
          committed: false,
          error: `lorebook.upsert: entry ${entry.id} missing content`,
        };
      }
      if (entry.strategy !== "constant" && entry.strategy !== "selective") {
        return {
          committed: false,
          error: `lorebook.upsert: entry ${entry.id} has invalid strategy`,
        };
      }
      const keys = Array.isArray(entry.keys)
        ? (entry.keys as unknown[]).filter(
            (k): k is string => typeof k === "string",
          )
        : [];
      records.push({
        id: entry.id,
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

    await store.upsertLorebookEntries(records);

    return { committed: true };
  }
}
