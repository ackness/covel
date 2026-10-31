import { overlayPluginDataValue } from "@covel/tools";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  proposalReadPreconditionSchema as conditionSchema,
  proposalReadScopesSchema as scopesSchema,
  checkProposalPayload,
  materializeCharacterUpsert,
  MAX_PLUGIN_DATA_VALUE_BYTES,
  type CharacterRecord,
  type DataOpsCurrent,
  type Proposal,
  type ProposalReadPrecondition,
  type ProposalReadScope,
} from "@covel/shared";
import type { KernelStore } from "./session/session-kernel-store.js";

const DIAGNOSTIC =
  "Read-baseline evidence is invalid or exceeds the supported size. Read fewer records before replacing data.";
export const READ_CONFLICT =
  "Data used to calculate this replacement changed. Retry explicitly from current reads.";
export const READ_TARGET_CHANGED =
  "A commit hook cannot redirect a guarded write target.";

/** Validate before canonicalization; no JSON coercion of invalid observations. */
export function contentFingerprint(value: unknown): string {
  const path = new Set<object>();
  const validate = (node: unknown): void => {
    if (node === null || typeof node === "string" || typeof node === "boolean")
      return;
    if (typeof node === "number" && Number.isFinite(node)) return;
    if (typeof node !== "object" || path.has(node)) throw new Error(DIAGNOSTIC);
    if (
      !Array.isArray(node) &&
      Object.getPrototypeOf(node) !== Object.prototype &&
      Object.getPrototypeOf(node) !== null
    )
      throw new Error(DIAGNOSTIC);
    path.add(node);
    for (const child of Array.isArray(node) ? node : Object.values(node))
      validate(child);
    path.delete(node);
  };
  validate(value);
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function contentBasisOf(
  current: DataOpsCurrent,
): Extract<ProposalReadPrecondition, { kind: "plugin-data" }>["basis"] {
  return current.exists
    ? { exists: true, fingerprint: contentFingerprint(current.value) }
    : { exists: false };
}

/** Explicit semantic fields give materialized and persisted characters one basis. */
export function characterBasisOf(
  row: CharacterRecord | undefined | null,
): Extract<ProposalReadPrecondition, { kind: "character" }>["basis"] {
  if (!row) return { exists: false };
  const value = Object.fromEntries(
    Object.entries({
      name: row.name,
      aliases: row.aliases ?? [],
      type: row.type,
      description: row.description,
      fields: row.fields,
    }).filter(([, value]) => value !== undefined),
  );
  return {
    exists: true,
    version: row.version,
    fingerprint: contentFingerprint(value),
  };
}

function targetKey(condition: ProposalReadPrecondition): string {
  return condition.kind === "plugin-data"
    ? JSON.stringify([
        condition.kind,
        condition.pluginId,
        condition.namespace,
        condition.key,
      ])
    : JSON.stringify([condition.kind, condition.id]);
}

export interface ReadBaselineRecorder {
  observe(condition: ProposalReadPrecondition): void;
  snapshot(): readonly ProposalReadPrecondition[];
}

export function createReadBaselineRecorder(): ReadBaselineRecorder {
  const reads = new Map<string, ProposalReadPrecondition>();
  let bytes = 0;
  let invalid = false;
  return {
    observe(condition) {
      if (invalid) throw new Error(DIAGNOSTIC);
      const key = targetKey(condition);
      const previous = reads.get(key);
      if (previous) {
        if (canonicalJson(previous.basis) !== canonicalJson(condition.basis))
          reads.set(key, { ...previous, unstable: true });
        return;
      }
      bytes += Buffer.byteLength(JSON.stringify(condition));
      if (reads.size >= 4096 || bytes > MAX_PLUGIN_DATA_VALUE_BYTES) {
        invalid = true;
        throw new Error(DIAGNOSTIC);
      }
      reads.set(key, structuredClone(condition));
    },
    snapshot() {
      if (invalid) throw new Error(DIAGNOSTIC);
      return structuredClone([...reads.values()]);
    },
  };
}

const recorders = new WeakMap<object, ReadBaselineRecorder>();
export function baselinesFor(recorder: object): ReadBaselineRecorder {
  let scope = recorders.get(recorder);
  if (!scope) {
    scope = createReadBaselineRecorder();
    recorders.set(recorder, scope);
  }
  return scope;
}

const evidence = new WeakMap<object, readonly ProposalReadScope[]>();
const operationEvidence = new WeakMap<
  object,
  Readonly<Record<string, readonly ProposalReadScope[]>>
>();
export function readScopesOf(result: object): readonly ProposalReadScope[] {
  return evidence.get(result) ?? [];
}
export function attachReadScopes(
  result: object,
  scopes: readonly ProposalReadScope[],
): void {
  evidence.set(result, validateReadScopes(scopes));
}
export function attachRecordedBaselines(
  result: object,
  recorder: object,
): void {
  const scope = recorders.get(recorder);
  if (!scope) return;
  const reads = scope.snapshot();
  if (reads.length)
    attachReadScopes(result, [...readScopesOf(result), { reads }]);
}
export function attachOperationBaselines(
  result: object,
  scopes: Readonly<Record<string, readonly ProposalReadScope[]>>,
): void {
  operationEvidence.set(result, structuredClone(scopes));
}
export interface ExecutionReadBaselines {
  readonly runs: Readonly<Record<string, readonly ProposalReadScope[]>>;
  readonly operations: Readonly<Record<string, readonly ProposalReadScope[]>>;
}
export function collectReadBaselines(
  results: readonly { readonly runId: string }[],
): ExecutionReadBaselines {
  return {
    runs: Object.fromEntries(
      results.map((result) => [result.runId, readScopesOf(result)]),
    ),
    operations: Object.assign(
      {},
      ...results.map((result) => operationEvidence.get(result) ?? {}),
    ) as ExecutionReadBaselines["operations"],
  };
}
export function validateReadScopes(
  scopes: unknown,
): readonly ProposalReadScope[] {
  const parsed = scopesSchema.safeParse(scopes);
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_PLUGIN_DATA_VALUE_BYTES
  )
    throw new Error(DIAGNOSTIC);
  return parsed.data;
}

/** Public/author copies never carry host envelope metadata. */
export function withoutReadPreconditions<
  T extends { readonly preconditions?: unknown },
>(proposal: T): Omit<T, "preconditions"> {
  const { preconditions: _preconditions, ...publicProposal } = proposal;
  return publicProposal;
}

/** Author-chosen IDs cannot impersonate proposals from an earlier scope. */
export function ownScopeProposals(
  proposals: readonly Proposal[],
  reserved: readonly Proposal[] = [],
): Proposal[] {
  const ids = new Set(reserved.map((proposal) => proposal.id));
  return proposals.map((raw) => {
    const proposal = structuredClone(withoutReadPreconditions(raw)) as Proposal;
    let id = proposal.id;
    while (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    return { ...withoutReadPreconditions(proposal), id } as Proposal;
  });
}

/** Saved invocations precede this invocation's effects and buffered writes. */
export function orderReadScopeProposals(
  proposals: readonly Proposal[],
  scopes: readonly ProposalReadScope[],
): Proposal[] {
  const saved = new Set(scopes.flatMap((scope) => scope.proposalIds ?? []));
  return [
    ...proposals.filter((proposal) => saved.has(proposal.id)),
    ...proposals.filter((proposal) => !saved.has(proposal.id)),
  ];
}

function targets(
  proposal: Proposal,
): { readonly key: string; readonly replacement: boolean }[] {
  switch (proposal.type) {
    case "plugin.data.batch":
      return proposal.payload.items.map((item) => ({
        key: targetKey({
          kind: "plugin-data",
          pluginId: proposal.source.pluginId,
          ...item,
          basis: { exists: false },
        }),
        replacement: true,
      }));
    case "plugin.data":
    case "plugin.data.delete":
    case "plugin.data.update":
      return [
        {
          key: targetKey({
            kind: "plugin-data",
            pluginId: proposal.source.pluginId,
            ...proposal.payload,
            basis: { exists: false },
          }),
          replacement:
            proposal.type !== "plugin.data.update" ||
            proposal.payload.ops.some((op) =>
              ["set", "merge", "upsertItem", "delete"].includes(op.op),
            ),
        },
      ];
    case "character.upsert":
      return [
        {
          key: targetKey({
            kind: "character",
            id: proposal.payload.id,
            basis: { exists: false },
          }),
          replacement: true,
        },
      ];
    default:
      return [];
  }
}

/** Stamp only trusted scope evidence, including the relative prefix of a replacement. */
export function stampReadPreconditions(
  proposals: readonly Proposal[],
  rawScopes: readonly ProposalReadScope[],
  original: readonly Proposal[] = [],
): Proposal[] {
  const scopes = validateReadScopes(rawScopes);
  const output = proposals.map(
    (proposal) => withoutReadPreconditions(proposal) as Proposal,
  );
  const savedIds = new Set(scopes.flatMap((scope) => scope.proposalIds ?? []));
  for (const scope of scopes) {
    const ids = scope.proposalIds ? new Set(scope.proposalIds) : undefined;
    const members = output.filter((proposal) =>
      ids ? ids.has(proposal.id) : !savedIds.has(proposal.id),
    );
    const pinned = original
      .filter((proposal) =>
        ids ? ids.has(proposal.id) : !savedIds.has(proposal.id),
      )
      .flatMap((proposal) => (proposal.preconditions ?? []).map(targetKey));
    const replaced = new Set([
      ...pinned,
      ...members.flatMap((proposal) =>
        targets(proposal)
          .filter((target) => target.replacement)
          .map((target) => target.key),
      ),
    ]);
    const remaining = new Map(
      scope.reads
        .filter((read) => replaced.has(targetKey(read)))
        .map((read) => [targetKey(read), read]),
    );
    for (const proposal of members) {
      const conditions: ProposalReadPrecondition[] = [];
      for (const { key } of targets(proposal)) {
        const condition = remaining.get(key);
        if (condition) {
          conditions.push(condition);
          remaining.delete(key);
        }
      }
      if (conditions.length)
        Object.assign(proposal, {
          preconditions: [
            ...(proposal.preconditions ?? []),
            ...structuredClone(conditions),
          ],
        });
    }
  }
  return output;
}

/** Pin batch membership as well as individual target identities across hooks. */
export function sameReadTargets(a: Proposal, b: Proposal): boolean {
  try {
    return (
      canonicalJson(
        targets(a)
          .map(({ key }) => key)
          .sort(),
      ) ===
      canonicalJson(
        targets(b)
          .map(({ key }) => key)
          .sort(),
      )
    );
  } catch {
    return false;
  }
}

/** Called through the transaction-bound handle immediately before mutation. */
export async function checkReadPreconditions(
  store: Pick<KernelStore, "getPluginData" | "listCharacters">,
  proposal: Proposal,
): Promise<{ readonly error: string; readonly code: string } | undefined> {
  const parsed = z
    .array(conditionSchema)
    .max(4096)
    .safeParse(proposal.preconditions ?? []);
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_PLUGIN_DATA_VALUE_BYTES
  )
    return { error: DIAGNOSTIC, code: "proposal-invalid" };
  for (const condition of parsed.data) {
    try {
      if (
        !targets(proposal).some((target) => target.key === targetKey(condition))
      )
        return { error: DIAGNOSTIC, code: "proposal-invalid" };
    } catch {
      return { error: DIAGNOSTIC, code: "proposal-invalid" };
    }
    const row =
      condition.kind === "plugin-data"
        ? await store.getPluginData?.(
            proposal.sessionId,
            condition.pluginId,
            condition.namespace,
            condition.key,
          )
        : (await store.listCharacters?.(proposal.sessionId))?.find(
            (row) => row.id === condition.id,
          );
    if (
      condition.kind === "plugin-data"
        ? !store.getPluginData
        : !store.listCharacters
    )
      return { error: DIAGNOSTIC, code: "proposal-invalid" };
    const basis =
      condition.kind === "plugin-data"
        ? contentBasisOf(
            row
              ? {
                  exists: true,
                  value: (row as { value: import("@covel/shared").JsonValue })
                    .value,
                }
              : { exists: false },
          )
        : characterBasisOf(row as CharacterRecord | null);
    if (
      condition.unstable ||
      canonicalJson(basis) !== canonicalJson(condition.basis)
    )
      return { error: READ_CONFLICT, code: "conflict" };
  }
  return undefined;
}

export function hasGuardedReadTarget(
  proposal: Proposal,
  original: readonly Proposal[],
): boolean {
  const keys = new Set(
    original.flatMap((entry) => (entry.preconditions ?? []).map(targetKey)),
  );
  return targets(proposal).some((target) => keys.has(target.key));
}

/** Save only evidence for pending targets; retain each original scope's prefix. */
export function saveReadScopes(
  proposals: readonly Proposal[],
  scopes: readonly ProposalReadScope[],
): readonly ProposalReadScope[] {
  const savedIds = new Set(scopes.flatMap((scope) => scope.proposalIds ?? []));
  const saved = validateReadScopes(scopes).flatMap((scope) => {
    const ids = scope.proposalIds ? new Set(scope.proposalIds) : undefined;
    const members = proposals.filter((proposal) =>
      ids ? ids.has(proposal.id) : !savedIds.has(proposal.id),
    );
    const keys = new Set(
      members.flatMap((proposal) =>
        targets(proposal).map((target) => target.key),
      ),
    );
    const reads = scope.reads.filter((read) => keys.has(targetKey(read)));
    return members.length
      ? [{ reads, proposalIds: members.map((proposal) => proposal.id) }]
      : [];
  });
  const covered = new Set(saved.flatMap((scope) => scope.proposalIds));
  const blindIds = proposals
    .filter((proposal) => !covered.has(proposal.id))
    .map((proposal) => proposal.id);
  return validateReadScopes([
    ...saved,
    ...(blindIds.length ? [{ reads: [], proposalIds: blindIds }] : []),
  ]);
}

/** Check pending scopes in order without persisting their speculative prefixes. */
export async function checkPendingReadBaselines(
  store: KernelStore,
  proposals: readonly Proposal[],
): Promise<{ proposal: Proposal; error: string; code: string } | undefined> {
  const prefix: Proposal[] = [];
  const characters = new Map<string, readonly CharacterRecord[]>();
  const reader: KernelStore = {
    ...store,
    getPluginData: store.getPluginData
      ? async (sessionId, pluginId, namespace, key) => {
          const row = await store.getPluginData!(
            sessionId,
            pluginId,
            namespace,
            key,
          );
          const next = overlayPluginDataValue(
            prefix,
            pluginId,
            namespace,
            key,
            row
              ? {
                  exists: true,
                  value: row.value as import("@covel/shared").JsonValue,
                }
              : { exists: false },
          );
          return next.exists
            ? {
                id: "pending",
                sessionId,
                pluginId,
                namespace,
                key,
                value: next.value,
                createdAt: "",
                updatedAt: "",
              }
            : null;
        }
      : undefined,
    listCharacters: store.listCharacters
      ? async (sessionId) =>
          characters.get(sessionId) ?? (await store.listCharacters!(sessionId))
      : undefined,
  };
  for (const proposal of proposals) {
    const failure = await checkReadPreconditions(reader, proposal);
    if (failure)
      return {
        proposal: withoutReadPreconditions(proposal) as Proposal,
        ...failure,
      };
    const checked = checkProposalPayload(proposal.type, proposal.payload);
    if (!checked.ok) continue;
    if (proposal.type === "character.upsert" && reader.listCharacters) {
      const rows = await reader.listCharacters(proposal.sessionId);
      const next = materializeCharacterUpsert(
        proposal.payload,
        rows.find((row) => row.id === proposal.payload.id),
        proposal.sessionId,
        "",
      );
      characters.set(proposal.sessionId, [
        ...rows.filter((row) => row.id !== next.id),
        next,
      ]);
    }
    prefix.push({ ...proposal, payload: checked.payload } as Proposal);
  }
  return undefined;
}

export function operationReadScopesOf(
  result: object,
): ExecutionReadBaselines["operations"] {
  return operationEvidence.get(result) ?? {};
}
