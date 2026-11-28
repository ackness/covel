import type { LorebookEntryRecord } from "@covel/store";
import type {
  BranchBasePayload,
  BranchCollectionDelta,
  BranchTurnNode,
  MaterializedBranchState,
  TurnStateDelta,
} from "./types.js";

export class BranchNodeNotFoundError extends Error {
  constructor(readonly nodeId: string) {
    super(`Branch node not found: ${nodeId}`);
    this.name = "BranchNodeNotFoundError";
  }
}

export class BranchNodeCycleError extends Error {
  constructor(readonly nodeId: string) {
    super(`Cycle detected in branch tree at node: ${nodeId}`);
    this.name = "BranchNodeCycleError";
  }
}

/** Canonical delta key for a session plugin-data row. */
export function branchPluginDataKey(
  pluginId: string,
  namespace: string,
  key: string,
): string {
  return `${pluginId}\u0000${namespace}\u0000${key}`;
}

/** Canonical delta key for a session lorebook entry, scoped by owner and id. */
export function branchLorebookEntryKey(
  owner: LorebookEntryRecord["owner"],
  id: string,
): string {
  const ownerKey =
    owner.kind === "plugin" ? `plugin:${owner.pluginId}` : owner.kind;
  return `${ownerKey}\u0000${id}`;
}

/** Return the path from the root node through `targetNodeId`, inclusive. */
export function branchPathToNode(
  nodes: readonly BranchTurnNode[],
  targetNodeId: string,
): readonly BranchTurnNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const path: BranchTurnNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(targetNodeId);
  if (!current) throw new BranchNodeNotFoundError(targetNodeId);
  while (current) {
    if (seen.has(current.id)) throw new BranchNodeCycleError(current.id);
    seen.add(current.id);
    path.push(current);
    const parentId = current.parentNodeId;
    if (!parentId) break;
    current = byId.get(parentId);
    if (!current) throw new BranchNodeNotFoundError(parentId);
  }
  return path.reverse();
}

/** Return the active path from root to the selected node. */
export function activeBranchPath(
  nodes: readonly BranchTurnNode[],
  activeNodeId: string | null,
): readonly BranchTurnNode[] {
  return activeNodeId ? branchPathToNode(nodes, activeNodeId) : [];
}

/** Find the nearest common ancestor of two nodes. */
export function lowestCommonAncestor(
  nodes: readonly BranchTurnNode[],
  leftNodeId: string,
  rightNodeId: string,
): BranchTurnNode {
  const left = branchPathToNode(nodes, leftNodeId);
  const right = branchPathToNode(nodes, rightNodeId);
  const limit = Math.min(left.length, right.length);
  let common: BranchTurnNode | undefined;
  for (let index = 0; index < limit; index += 1) {
    if (left[index]!.id !== right[index]!.id) break;
    common = left[index];
  }
  if (!common)
    throw new Error(
      `Branch nodes do not share a root: ${leftNodeId}, ${rightNodeId}`,
    );
  return common;
}

/** Follow active-child links from a node to its selected leaf. */
export function activeLeafFromNode(
  nodes: readonly BranchTurnNode[],
  nodeId: string,
): BranchTurnNode {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const seen = new Set<string>();
  let current = byId.get(nodeId);
  if (!current) throw new BranchNodeNotFoundError(nodeId);
  while (current.activeChildId) {
    if (seen.has(current.id)) throw new BranchNodeCycleError(current.id);
    seen.add(current.id);
    const child = byId.get(current.activeChildId);
    if (!child) throw new BranchNodeNotFoundError(current.activeChildId);
    if (child.parentNodeId !== current.id) {
      throw new Error(
        `Branch node "${current.id}" points to non-child activeChildId: ${child.id}`,
      );
    }
    current = child;
  }
  return current;
}

/** Materialize the state represented by a node's root-to-node checkpoint chain. */
export function materializeBranchState(
  nodes: readonly BranchTurnNode[],
  targetNodeId: string,
): MaterializedBranchState {
  const path = branchPathToNode(nodes, targetNodeId);
  let baseIndex = -1;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path[index]!.checkpointKind === "base") {
      baseIndex = index;
      break;
    }
  }
  if (baseIndex < 0)
    throw new Error(`Branch node has no base checkpoint: ${targetNodeId}`);
  const baseNode = path[baseIndex]!;
  if (!isBasePayload(baseNode.statePayload))
    throw new Error(`Base checkpoint payload is incomplete: ${baseNode.id}`);
  let state = cloneBase(baseNode.statePayload);
  if (baseNode.tailDelta != null) {
    state = applyTurnStateDelta(
      state,
      requireDeltaPayload(baseNode.tailDelta, baseNode.id),
    );
  }
  for (const node of path.slice(baseIndex + 1)) {
    if (node.checkpointKind !== "delta") {
      throw new Error(
        `Unexpected checkpoint kind "${String(node.checkpointKind)}" at node: ${node.id}`,
      );
    }
    state = applyTurnStateDelta(
      state,
      requireDeltaPayload(node.statePayload, node.id),
    );
    if (node.tailDelta != null) {
      state = applyTurnStateDelta(
        state,
        requireDeltaPayload(node.tailDelta, node.id),
      );
    }
  }
  return state;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireDeltaPayload(payload: unknown, nodeId: string): TurnStateDelta {
  if (!isPlainObject(payload)) {
    throw new Error(`Delta checkpoint payload is invalid: ${nodeId}`);
  }
  return payload as TurnStateDelta;
}

function isBasePayload(payload: unknown): payload is BranchBasePayload {
  if (!isPlainObject(payload)) return false;
  return (
    isPlainObject(payload.session) &&
    payload.characterSchema !== undefined &&
    Array.isArray(payload.characters) &&
    Array.isArray(payload.pluginData) &&
    Array.isArray(payload.lorebookEntries) &&
    Array.isArray(payload.runtimeExports) &&
    Array.isArray(payload.suspensions) &&
    Array.isArray(payload.sessionSummaries) &&
    isPlainObject(payload.compactedMessageSummaryIds) &&
    Array.isArray(payload.messages) &&
    Array.isArray(payload.turnMessages) &&
    Array.isArray(payload.playerInputs) &&
    Array.isArray(payload.interactionRecords)
  );
}

function cloneBase(payload: BranchBasePayload): MaterializedBranchState {
  return structuredClone({
    session: payload.session,
    characterSchema: payload.characterSchema,
    characters: [...payload.characters],
    pluginData: [...payload.pluginData],
    lorebookEntries: [...payload.lorebookEntries],
    runtimeExports: [...payload.runtimeExports],
    suspensions: [...payload.suspensions],
    sessionSummaries: [...payload.sessionSummaries],
    compactedMessageSummaryIds: { ...payload.compactedMessageSummaryIds },
    messages: [...payload.messages],
    turnMessages: [...payload.turnMessages],
    playerInputs: [...payload.playerInputs],
    interactionRecords: [...payload.interactionRecords],
  });
}

function applyTurnStateDelta(
  current: MaterializedBranchState,
  delta: TurnStateDelta,
): MaterializedBranchState {
  return {
    ...current,
    ...(delta.session !== undefined
      ? { session: structuredClone(delta.session) }
      : {}),
    ...(delta.characterSchema !== undefined
      ? { characterSchema: structuredClone(delta.characterSchema) }
      : {}),
    characters: applyCollectionDelta(
      current.characters,
      delta.characters,
      (row) => row.id,
    ),
    pluginData: applyCollectionDelta(
      current.pluginData,
      delta.pluginData,
      (row) => branchPluginDataKey(row.pluginId, row.namespace, row.key),
    ),
    lorebookEntries: applyCollectionDelta(
      current.lorebookEntries,
      delta.lorebookEntries,
      (row) => branchLorebookEntryKey(row.owner, row.id),
    ),
    runtimeExports: delta.runtimeExports
      ? structuredClone([...delta.runtimeExports])
      : current.runtimeExports,
    suspensions: delta.suspensions
      ? structuredClone([...delta.suspensions])
      : current.suspensions,
    sessionSummaries: delta.sessionSummaries
      ? structuredClone([...delta.sessionSummaries])
      : current.sessionSummaries,
    compactedMessageSummaryIds: delta.compactedMessageSummaryIds
      ? { ...delta.compactedMessageSummaryIds }
      : current.compactedMessageSummaryIds,
    messages: delta.messagesAdded?.length
      ? appendUnique(current.messages, delta.messagesAdded, (row) => row.id)
      : current.messages,
    turnMessages: delta.turnMessagesAdded?.length
      ? appendUnique(
          current.turnMessages,
          delta.turnMessagesAdded,
          (row) => row.id,
        )
      : current.turnMessages,
    playerInputs: delta.playerInputsAdded?.length
      ? appendUnique(
          current.playerInputs,
          delta.playerInputsAdded,
          (row) => row.id,
        )
      : current.playerInputs,
    interactionRecords: delta.interactionRecordsAdded?.length
      ? appendUnique(
          current.interactionRecords,
          delta.interactionRecordsAdded,
          (row) => row.id,
        )
      : current.interactionRecords,
  };
}

function applyCollectionDelta<T>(
  current: readonly T[],
  delta: BranchCollectionDelta<T> | undefined,
  keyOf: (row: T) => string,
): readonly T[] {
  if (!delta) return current;
  const deleted = new Set(delta.deletes);
  const rows = new Map(
    current
      .filter((row) => !deleted.has(keyOf(row)))
      .map((row) => [keyOf(row), row]),
  );
  for (const row of delta.upserts) rows.set(keyOf(row), structuredClone(row));
  return [...rows.values()];
}

function appendUnique<T>(
  current: readonly T[],
  additions: readonly T[],
  keyOf: (row: T) => string,
): readonly T[] {
  const rows = new Map(current.map((row) => [keyOf(row), row]));
  for (const row of additions) rows.set(keyOf(row), structuredClone(row));
  return [...rows.values()];
}
