/** Session turn-tree topology and branch checkout routes. */
import { Hono, type Context } from "hono";
import {
  branchDeleteRequestSchema,
  branchLabelRequestSchema,
  branchSwitchRequestSchema,
  type BranchDeleteResponse,
  type SessionBranchSummary,
  type TurnNodeSummary,
} from "@covel/shared/branch";
import type { DataStore, SessionRecord, TurnNodeRecord } from "@covel/store";
import { errorBody, parseJsonBody } from "../../api-error.js";
import type { SessionLock } from "../../lib/session-lock.js";
import { withLockedSessionMutation } from "./session/locked-mutation.js";
import {
  resolveSessionParam,
  SESSION_NOT_FOUND_CODE,
} from "./session/session-guard.js";

type CheckoutCapableStore = DataStore & {
  checkoutTurnNode?: (
    sessionId: string,
    nodeId: string,
    options?: { readonly discardUnsettled?: boolean },
  ) => Promise<void>;
};

type Env = {
  Variables: {
    store: DataStore;
    sessionLock: SessionLock;
  };
};

export const branchRoutes = new Hono<Env>();

function summary(node: TurnNodeRecord, childCount?: number): TurnNodeSummary {
  return {
    id: node.id,
    parentNodeId: node.parentNodeId ?? null,
    activeChildId: node.activeChildId ?? null,
    turnId: node.turnId,
    logicalTurn: node.logicalTurn,
    seq: node.seq,
    ...(node.label == null ? {} : { label: node.label }),
    ...(node.inputSummary == null ? {} : { inputSummary: node.inputSummary }),
    checkpointKind: node.checkpointKind,
    createdAt: node.createdAt,
    ...(childCount === undefined ? {} : { childCount }),
  };
}

async function branchSummary(
  store: DataStore,
  session: SessionRecord,
): Promise<SessionBranchSummary> {
  const nodes = await store.listTurnNodes(session.id);
  const childCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.parentNodeId != null) {
      childCounts.set(
        node.parentNodeId,
        (childCounts.get(node.parentNodeId) ?? 0) + 1,
      );
    }
  }
  return {
    activeNodeId: session.activeNodeId ?? null,
    branchEpoch: session.branchEpoch ?? 0,
    nodes: nodes.map((node) => summary(node, childCounts.get(node.id) ?? 0)),
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

/** Parse an optional DELETE JSON body; empty body defaults to `{}`. */
async function parseOptionalDeleteBody(
  c: Context,
): Promise<{ body: { readonly discardUnsettled?: boolean } } | Response> {
  const raw = await c.req.text();
  if (raw.trim().length === 0) return { body: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return c.json(
      errorBody("Invalid JSON body", { code: "invalid_json_body" }),
      400,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return c.json(
      errorBody("Body must be a JSON object", {
        code: "invalid_request_body",
      }),
      400,
    );
  }
  const parsed = branchDeleteRequestSchema.safeParse(value);
  if (!parsed.success) {
    return c.json(
      errorBody("Invalid request body", {
        code: "invalid_request_body",
        details: parsed.error.flatten(),
      }),
      400,
    );
  }
  return { body: parsed.data };
}

function compareSiblingOrder(
  left: TurnNodeRecord,
  right: TurnNodeRecord,
): number {
  if (left.seq !== right.seq) return left.seq - right.seq;
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function collectSubtreeIds(
  nodes: readonly TurnNodeRecord[],
  rootId: string,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentNodeId == null) continue;
    const list = childrenByParent.get(node.parentNodeId);
    if (list) list.push(node.id);
    else childrenByParent.set(node.parentNodeId, [node.id]);
  }
  const ids = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ids.has(current)) continue;
    ids.add(current);
    const children = childrenByParent.get(current);
    if (children) {
      for (const childId of children) stack.push(childId);
    }
  }
  return ids;
}

branchRoutes.get("/:id/branches", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  return c.json(await branchSummary(c.get("store"), guard.session));
});

branchRoutes.post("/:id/branches/switch", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const parsed = await parseJsonBody(c, branchSwitchRequestSchema);
  if (parsed instanceof Response) return parsed;
  const store = c.get("store") as CheckoutCapableStore;
  if (typeof store.checkoutTurnNode !== "function") return unavailable(c);
  const id = guard.session.id;
  return withLockedSessionMutation({
    c,
    store,
    sessionLock: c.get("sessionLock"),
    sessionId: id,
    expectedSession: guard.session,
    allowedStatuses: "any",
    mutate: async () => {
      const target = await store.getTurnNode(parsed.body.nodeId);
      if (!target || target.sessionId !== id) {
        return c.json(
          errorBody("Branch node not found", { code: "not_found" }),
          404,
        );
      }
      await store.checkoutTurnNode!(id, parsed.body.nodeId, {
        discardUnsettled: parsed.body.discardUnsettled,
      });
      const updatedSession = await store.getSession(id);
      if (!updatedSession) {
        return c.json(
          errorBody(`Session not found: ${id}`, {
            code: SESSION_NOT_FOUND_CODE,
          }),
          404,
        );
      }
      return c.json(await branchSummary(store, updatedSession));
    },
  });
});

branchRoutes.patch("/:id/branches/nodes/:nodeId", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const parsed = await parseJsonBody(c, branchLabelRequestSchema);
  if (parsed instanceof Response) return parsed;
  const store = c.get("store");
  const id = guard.session.id;
  const nodeId = c.req.param("nodeId");
  return withLockedSessionMutation({
    c,
    store,
    sessionLock: c.get("sessionLock"),
    sessionId: id,
    expectedSession: guard.session,
    allowedStatuses: "any",
    mutate: async () => {
      const live = await store.getTurnNode(nodeId);
      if (!live || live.sessionId !== id) {
        return c.json(
          errorBody("Branch node not found", { code: "not_found" }),
          404,
        );
      }
      if (live.parentNodeId == null) {
        return c.json(
          errorBody("The root branch cannot be renamed", {
            code: "cannot_rename_root_node",
          }),
          400,
        );
      }
      const { label: _previousLabel, ...withoutLabel } = live;
      const updated: TurnNodeRecord =
        parsed.body.label === null
          ? withoutLabel
          : { ...withoutLabel, label: parsed.body.label };
      await store.saveTurnNode(updated);
      return c.json(summary(updated));
    },
  });
});

branchRoutes.delete("/:id/branches/nodes/:nodeId", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const parsed = await parseOptionalDeleteBody(c);
  if (parsed instanceof Response) return parsed;
  const store = c.get("store");
  const id = guard.session.id;
  const nodeId = c.req.param("nodeId");
  return withLockedSessionMutation({
    c,
    store,
    sessionLock: c.get("sessionLock"),
    sessionId: id,
    expectedSession: guard.session,
    allowedStatuses: "any",
    mutate: async () => {
      const outcome = await store.withTransaction(async (tx) => {
        const liveSession = await tx.getSession(id);
        if (!liveSession) return { kind: "session-not-found" as const };
        const nodes = await tx.listTurnNodes(id);
        const root = nodes.find((node) => node.id === nodeId);
        if (!root) return { kind: "not-found" as const };
        if (root.parentNodeId == null) return { kind: "root-node" as const };
        const ids = collectSubtreeIds(nodes, root.id);
        if (
          liveSession.activeNodeId != null &&
          ids.has(liveSession.activeNodeId)
        ) {
          return { kind: "active-subtree" as const };
        }
        const parent = nodes.find((node) => node.id === root.parentNodeId);
        if (parent?.activeChildId === root.id) {
          const replacement = nodes
            .filter(
              (node) => node.parentNodeId === parent.id && !ids.has(node.id),
            )
            .sort(compareSiblingOrder)[0];
          await tx.saveTurnNode({
            ...parent,
            activeChildId: replacement?.id ?? null,
          });
        }
        for (const targetId of ids) await tx.deleteTurnNode(targetId);
        const response: BranchDeleteResponse = {
          deletedNodeIds: [...ids],
          activeNodeId: liveSession.activeNodeId ?? null,
          branchEpoch: liveSession.branchEpoch ?? 0,
          switched: false,
        };
        return { kind: "deleted" as const, response };
      });
      switch (outcome.kind) {
        case "session-not-found":
          return c.json(
            errorBody(`Session not found: ${id}`, {
              code: SESSION_NOT_FOUND_CODE,
            }),
            404,
          );
        case "not-found":
          return c.json(
            errorBody("Branch node not found", { code: "not_found" }),
            404,
          );
        case "root-node":
          return c.json(
            errorBody("The root branch cannot be deleted", {
              code: "cannot_delete_root_node",
            }),
            400,
          );
        case "active-subtree":
          return c.json(
            errorBody(
              "Cannot delete the active branch before checkout is available",
              { code: "branch_checkout_required" },
            ),
            409,
          );
        case "deleted":
          return c.json(outcome.response);
      }
    },
  });
});
