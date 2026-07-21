/** Commit handlers for `working_memory.set` and `lorebook.upsert`. */

import type { CommitResult, ProposalFor } from "@covel/shared";
import { workingMemoryQuotaViolation } from "@covel/shared";
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

/**
 * Storage-quota check shared with the REST working-memory route — the limits
 * and off-by-one semantics live in `@covel/shared` (`working-memory-quota.ts`)
 * so the two write paths cannot drift apart. `listWorkingMemory` is optional
 * on KernelStore; without it the entry-count check is skipped and only the
 * value-size cap applies.
 */
async function workingMemoryQuotaFailure(
  store: KernelStore,
  sessionId: string,
  scope: string,
  key: string,
  value: unknown,
): Promise<CommitResult | undefined> {
  const existing = store.listWorkingMemory
    ? await store.listWorkingMemory(sessionId)
    : undefined;
  const violation = workingMemoryQuotaViolation(scope, key, value, existing);
  return violation
    ? commitError(`working_memory.set: ${violation.message}`)
    : undefined;
}

export function createMemoryLoreCommitHandlers(
  store: KernelStore,
): Pick<CommitHandlerMap, "working_memory.set" | "lorebook.upsert"> {
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
    const overQuota = await workingMemoryQuotaFailure(
      store,
      proposal.sessionId,
      scope,
      key,
      payload.value,
    );
    if (overQuota) return overQuota;

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

  return {
    "working_memory.set": commitWorkingMemory,
    "lorebook.upsert": commitLorebookUpsert,
  };
}
