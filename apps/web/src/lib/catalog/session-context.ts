import { useSession } from "@/stores/session-store.js";

/**
 * Soft-bind to SessionContext: catalog renderers can be mounted in tests,
 * debug fixtures, and snapshot panels outside a SessionProvider.
 */
export function useActiveSessionId(): string {
  try {
    const { state } = useSession();
    return state.session?.id ?? "";
  } catch {
    return "";
  }
}
