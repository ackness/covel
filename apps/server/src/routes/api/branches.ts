/** Session turn-tree topology and branch checkout routes. */
import { Hono, type Context } from "hono";
import {
  branchDeleteRequestSchema,
  branchLabelRequestSchema,
  branchSwitchRequestSchema,
  type BranchDeleteResponse,
  type SessionBranchSummary,
  type TurnNodeSummary as ApiTurnNodeSummary,
} from "@covel/shared";
import type { DataStore, TurnNodeRecord } from "@covel/store";
import { errorBody } from "../../api-error.js";
import { withSettledSessionLock } from "./plugin-rpc/settled-request.js";
import { resolveSessionParam } from "./session/session-guard.js";

type BranchStore = DataStore & {
  saveTurnNode?: (record: TurnNodeRecord) => Promise<void>;
  checkoutTurnNode?: (
    sessionId: string,
    nodeId: string,
    options?: { readonly discardUnsettled?: boolean },
  ) => Promise<void>;
};

type BranchNode = TurnNodeRecord;

export const branchRoutes = new Hono();

function summary(node: BranchNode): ApiTurnNodeSummary {
  return {
    id: node.id,
    parentNodeId: node.parentNodeId ?? null,
    activeChildId: node.activeChildId ?? null,
    turnId: node.turnId,
    logicalTurn: node.logicalTurn,
    seq: node.seq,
    ...(node.label == null ? {} : { label: node.label }),
    ...(node.inputSummary === undefined
      ? {}
      : { inputSummary: node.inputSummary as ApiTurnNodeSummary["inputSummary"] }),
    checkpointKind: node.checkpointKind,
    createdAt: node.createdAt,
  };
}

async function branchSummary(
  store: BranchStore,
  sessionId: string,
): Promise<SessionBranchSummary> {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const nodes = await store.listTurnNodes(sessionId);
  return {
    activeNodeId: session.activeNodeId ?? null,
    branchEpoch: session.branchEpoch ?? 0,
    nodes: nodes.map(summary),
  };
}

function unavailable(c: Context): Response {
  return c.json(
    errorBody("Turn branching is not available on this store", {
      code: "branching_unavailable",
    }),
    501,
  );
}

branchRoutes.get("/:id/branches", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  return c.json(await branchSummary(c.get("store") as BranchStore, guard.session.id));
});

branchRoutes.post("/:id/branches/switch", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const parsed = branchSwitchRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid branch switch request", { code: "invalid_branch_request" }), 400);
  const store = c.get("store") as BranchStore;
  const checkoutTurnNode = store.checkoutTurnNode;
  if (!checkoutTurnNode) return unavailable(c);
  const id = guard.session.id;
  const result = await withSettledSessionLock(c, id, async () => {
    await checkoutTurnNode!(id, parsed.data.nodeId, {
      discardUnsettled: parsed.data.discardUnsettled,
    });
    return branchSummary(store, id);
  });
  return c.json(result);
});

branchRoutes.patch("/:id/branches/nodes/:nodeId", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const parsed = branchLabelRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid branch label request", { code: "invalid_branch_request" }), 400);
  const store = c.get("store") as BranchStore;
  if (!store.saveTurnNode) return unavailable(c);
  const node = await store.getTurnNode(c.req.param("nodeId"));
  if (!node || node.sessionId !== guard.session.id)
    return c.json(errorBody("Branch node not found", { code: "not_found" }), 404);
  if (node.parentNodeId === null)
    return c.json(errorBody("The root branch cannot be renamed", { code: "cannot_rename_root_node" }), 400);
  const updated = await c.get("sessionLock").withLock(guard.session.id, async () => {
    const live = await store.getTurnNode(node.id);
    if (!live || live.sessionId !== guard.session.id) return null;
    await store.saveTurnNode({ ...live, label: parsed.data.label });
    return { ...live, label: parsed.data.label };
  });
  if (!updated)
    return c.json(errorBody("Branch node not found", { code: "not_found" }), 404);
  return c.json(summary(updated));
});

branchRoutes.delete("/:id/branches/nodes/:nodeId", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const parsed = branchDeleteRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json(errorBody(parsed.error.issues[0]?.message ?? "Invalid branch delete request", { code: "invalid_branch_request" }), 400);
  const store = c.get("store") as BranchStore;
  const id = guard.session.id;
  const requested = await store.getTurnNode(c.req.param("nodeId"));
  if (!requested || requested.sessionId !== id)
    return c.json(errorBody("Branch node not found", { code: "not_found" }), 404);
  if (requested.parentNodeId === null)
    return c.json(errorBody("The root branch cannot be deleted", { code: "cannot_delete_root_node" }), 400);
  const deletedNodeIds = await withSettledSessionLock(c, id, async () => {
    const root = await store.getTurnNode(c.req.param("nodeId"));
    if (!root || root.sessionId !== id) return null;
    const nodes = await store.listTurnNodes(id);
    const ids = new Set<string>();
    const visit = (nodeId: string): void => {
      if (ids.has(nodeId)) return;
      ids.add(nodeId);
      for (const child of nodes)
        if (child.parentNodeId === nodeId) visit(child.id);
    };
    visit(root.id);
    if (ids.has((await store.getSession(id))?.activeNodeId ?? "")) {
      return "active-subtree" as const;
    }
    if (root.parentNodeId) {
      const parent = nodes.find((node) => node.id === root.parentNodeId);
      if (parent?.activeChildId === root.id) {
        const replacement = nodes
          .filter(
            (node) =>
              node.parentNodeId === parent.id && !ids.has(node.id),
          )
          .sort((left, right) => left.seq - right.seq)[0];
        await store.saveTurnNode({
          ...parent,
          activeChildId: replacement?.id ?? null,
        });
      }
    }
    for (const nodeId of ids) await store.deleteTurnNode(nodeId);
    return [...ids];
  });
  if (deletedNodeIds === "active-subtree")
    return c.json(
      errorBody("Cannot delete the active branch before checkout is available", {
        code: "branch_checkout_required",
      }),
      409,
    );
  if (!deletedNodeIds)
    return c.json(errorBody("Branch node not found", { code: "not_found" }), 404);
  const current = await branchSummary(store, id);
  const response: BranchDeleteResponse = {
    deletedNodeIds,
    activeNodeId: current.activeNodeId,
    branchEpoch: current.branchEpoch,
    switched: deletedNodeIds.includes(guard.session.activeNodeId ?? ""),
  };
  return c.json(response);
});
