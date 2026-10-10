import type { RpcHandlerStore } from "@covel/shared";

/** The session-bound store view a plugin RPC handler receives, with no data. */
export function emptyRpcStore(): RpcHandlerStore {
  return {
    getSession: async () => null,
    listTurnMessages: async () => [],
  };
}
