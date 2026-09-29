import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore, SessionRecord } from "@covel/store";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../session/session-guard.js";

/** Keep an execution's graph while checking revocation against live authority. */
export function createPluginServiceAdmission(args: {
  readonly store: Pick<DataStore, "getSession">;
  readonly registry: Pick<PluginRegistry, "getActivePlugins">;
  readonly ensurePluginEntry: (
    pluginId: string,
    sessionId: string,
  ) => Promise<void>;
  /** Discovery skips recently failed entries instead of re-running them. */
  readonly isEntryRetryDeferred?: (pluginId: string) => boolean;
}) {
  const executions = new AsyncLocalStorage<SessionRecord>();
  const activeIds = (session: SessionRecord): readonly string[] =>
    executions.getStore()
      ? args.registry.getActivePlugins(session.id)
      : session.activePlugins;

  async function ensure(sessionId: string, pluginId: string): Promise<string> {
    const live = await args.store.getSession(sessionId);
    if (!live) throw new Error("Plugin service session is unavailable");
    return admit(live, pluginId);
  }

  async function admit(live: SessionRecord, pluginId: string): Promise<string> {
    const sessionId = live.id;
    const captured = executions.getStore();
    if (
      captured &&
      (captured.id !== sessionId ||
        sessionIncarnationIdentity(captured) !==
          sessionIncarnationIdentity(live) ||
        sessionApprovalScope(captured, pluginId) !==
          sessionApprovalScope(live, pluginId))
    )
      throw new Error("Plugin service execution authority was revoked");
    if (!activeIds(live).includes(pluginId))
      throw new Error(`Plugin is not active: ${pluginId}`);
    await args.ensurePluginEntry(pluginId, sessionId);
    return sessionIncarnationIdentity(live);
  }

  return {
    /** Invoke only while the host holds the session lock for artifact capture. */
    async capture(sessionId: string) {
      const parent = executions.getStore();
      if (parent) {
        if (parent.id !== sessionId)
          throw new Error("Plugin service snapshot belongs to another session");
        return { run: <T>(fn: () => T): T => fn() };
      }
      const session = await args.store.getSession(sessionId);
      if (!session) throw new Error("Plugin service session is unavailable");
      const captured = structuredClone(session);
      return { run: <T>(fn: () => T): T => executions.run(captured, fn) };
    },
    admission: {
      ensure,
      async list(sessionId: string): Promise<string[]> {
        const session = await args.store.getSession(sessionId);
        if (!session) return [];
        const admitted: string[] = [];
        for (const pluginId of activeIds(session)) {
          if (args.isEntryRetryDeferred?.(pluginId)) continue;
          try {
            // One live read authorizes the whole list.
            await admit(session, pluginId);
            admitted.push(pluginId);
          } catch {
            // Revoked, unapproved and failed entries are not discoverable.
          }
        }
        return admitted;
      },
    },
  };
}
