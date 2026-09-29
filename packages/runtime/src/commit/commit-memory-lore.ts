/** Authoritative lorebook commit handler. */

import type { CommitResult, ProposalFor } from "@covel/shared";
import { makeEvent } from "../session/session-kernel-helpers.js";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import {
  commitError,
  firstFailure,
  requireNonEmptyArray,
  requireNonEmptyString,
  requireOptionalString,
} from "./commit-validators.js";

export function createMemoryLoreCommitHandlers(
  store: KernelStore,
): Pick<CommitHandlerMap, "lorebook.upsert"> {
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
      owner: import("@covel/shared").LorebookOwner;
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
      const owner = {
        kind: "plugin",
        pluginId: proposal.source.pluginId,
      } as const;
      if (entry.owner !== undefined) {
        const requested = entry.owner as Record<string, unknown> | null;
        if (
          !requested ||
          requested.kind !== "plugin" ||
          requested.pluginId !== owner.pluginId
        )
          return commitError(
            "lorebook.upsert: cannot modify another owner's entry",
          );
      }
      const existing = await store.getLorebookEntry?.(
        proposal.sessionId,
        owner,
        entry.id as string,
      );
      records.push({
        id: entry.id as string,
        sessionId: proposal.sessionId,
        owner: { kind: "plugin", pluginId: proposal.source.pluginId },
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
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }

    await upsertLorebookEntries(records);

    return { committed: true };
  }

  return {
    "lorebook.upsert": commitLorebookUpsert,
  };
}
