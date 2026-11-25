import type { PluginAppEventHandler, PluginAppEventName } from "@covel/runtime";
import type { PluginRegistry } from "@covel/plugin-loader";
import { compareText } from "@covel/shared";
import {
  APP_EVENT_NAMES,
  type AppEventPayloadMap,
} from "@covel/shared/platform";
import type { DataStore } from "@covel/store";
import type { PermissionService } from "../../../trust/permission-service.js";
import type { SecretVault } from "../../../trust/secret-vault.js";
import type { TrustedSourceService } from "../../../trust/trusted-source-service.js";
import { checkInstancePluginAllowed } from "./instance-plugins.js";
import { withCallSignal } from "./entry-http.js";
import {
  buildPluginInstanceSurface,
  packageHttpPermissions,
  pickPluginInstanceSurfaceFields,
} from "./plugin-entry-api.js";

const APP_EVENT_HANDLER_TIMEOUT_MS = 10_000;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const obj = value as object;
  if (seen.has(obj)) return value;
  seen.add(obj);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, seen);
  } else {
    for (const key of Object.keys(obj)) {
      deepFreeze((obj as Record<string, unknown>)[key], seen);
    }
  }
  return Object.freeze(value);
}

interface RegisteredAppEventHandler {
  readonly pluginId: string;
  readonly event: PluginAppEventName;
  readonly handler: PluginAppEventHandler;
}

export interface AppEventDispatcherDeps {
  readonly registry: PluginRegistry;
  readonly store: DataStore;
  readonly hostId?: string;
  readonly secretVault?: SecretVault;
  readonly getPermissionService: () => PermissionService | undefined;
  readonly getTrustedSources: () => TrustedSourceService | undefined;
  readonly activateForEvent?: (event: string) => Promise<readonly string[]>;
  readonly handlerTimeoutMs?: number;
}

export interface AppEventDispatcher {
  register<E extends PluginAppEventName>(
    pluginId: string,
    event: E,
    handler: PluginAppEventHandler<E>,
  ): () => void;
  replacePlugin<T>(pluginId: string, publish: () => T): T;
  emit<E extends PluginAppEventName>(
    event: E,
    payload: AppEventPayloadMap[E],
  ): Promise<void>;
  list(): ReadonlyArray<{
    readonly pluginId: string;
    readonly event: PluginAppEventName;
  }>;
}

const busDispatchers = new WeakMap<object, AppEventDispatcher>();

export function linkAppEventDispatcherToBus(
  eventBus: object,
  dispatcher: AppEventDispatcher,
): void {
  busDispatchers.set(eventBus, dispatcher);
}

export function getAppEventDispatcherForBus(
  eventBus: object | undefined,
): AppEventDispatcher | undefined {
  return eventBus ? busDispatchers.get(eventBus) : undefined;
}

export function createAppEventDispatcher(
  deps: AppEventDispatcherDeps,
): AppEventDispatcher {
  const entries = new Map<string, RegisteredAppEventHandler>();
  let emitTail = Promise.resolve();
  const timeoutMs = deps.handlerTimeoutMs ?? APP_EVENT_HANDLER_TIMEOUT_MS;

  async function dispatchEvent<E extends PluginAppEventName>(
    event: E,
    payload: AppEventPayloadMap[E],
  ): Promise<void> {
    try {
      await deps.activateForEvent?.(`onAppEvent:${event}`);
    } catch (error) {
      console.warn(`[app-events] lazy activation failed for ${event}:`, error);
    }

    const listeners = [...entries.values()]
      .filter((item) => item.event === event)
      .sort((a, b) => compareText(a.pluginId, b.pluginId));
    if (listeners.length === 0) return;

    const frozenPayload = deepFreeze(structuredClone(payload));

    for (const listener of listeners) {
      const regEntry =
        deps.registry.getCurrent(listener.pluginId) ??
        deps.registry.get(listener.pluginId);
      if (!regEntry) continue;
      // Enforce L1/L2/L3 plugin.instanceScope uniformly for both builtin and
      // community packages (builtin still requires no communityCode grant).
      const allowed = await checkInstancePluginAllowed(
        {
          registry: deps.registry,
          permissionService: deps.getPermissionService(),
          trustedSources: deps.getTrustedSources(),
        },
        listener.pluginId,
      );
      if (!allowed) continue;

      const surface = buildPluginInstanceSurface({
        pluginId: listener.pluginId,
        pluginRegistry: deps.registry,
        store: deps.store,
        hostId: deps.hostId,
        secretVault: deps.secretVault,
        getPermissionService: deps.getPermissionService,
        httpPermissions: packageHttpPermissions(regEntry),
      });

      const ac = new AbortController();
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          const reason = ac.signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new DOMException("AppEvent handler timed out", "TimeoutError"),
          );
        };
        ac.signal.addEventListener("abort", onAbort, { once: true });
      });
      const timer = setTimeout(
        () =>
          ac.abort(
            new DOMException("AppEvent handler timed out", "TimeoutError"),
          ),
        timeoutMs,
      );
      timer.unref?.();
      try {
        const { sandbox: _sandbox, ...surfaceWithoutSandbox } =
          pickPluginInstanceSurfaceFields(surface);
        const task = Promise.resolve().then(() =>
          listener.handler(frozenPayload, {
            signal: ac.signal,
            pluginId: listener.pluginId,
            event,
            ...surfaceWithoutSandbox,
            http: withCallSignal(surface.http, ac.signal),
          }),
        );
        // Prevent a late post-timeout rejection from becoming unhandled.
        task.catch(() => {});
        await Promise.race([task, abortPromise]);
      } catch (error) {
        console.warn(
          `[app-events] handler error in plugin "${listener.pluginId}" for ${event}:`,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timer);
        if (onAbort) ac.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  return {
    register(pluginId, event, handler) {
      if (!(APP_EVENT_NAMES as readonly string[]).includes(event)) {
        throw new Error(`Unknown AppEvent name: ${String(event)}`);
      }
      if (typeof handler !== "function") {
        throw new Error("AppEvent handler must be a function");
      }
      const key = `${pluginId}:${event}`;
      if (entries.has(key)) {
        throw new Error(
          `AppEvent "${event}" already registered for plugin "${pluginId}"`,
        );
      }
      const record: RegisteredAppEventHandler = {
        pluginId,
        event,
        handler: handler as PluginAppEventHandler,
      };
      entries.set(key, record);
      return () => {
        if (entries.get(key) === record) entries.delete(key);
      };
    },

    replacePlugin<T>(pluginId: string, publish: () => T): T {
      const previous = [...entries.entries()].filter(
        ([, item]) => item.pluginId === pluginId,
      );
      for (const [key] of previous) entries.delete(key);
      try {
        return publish();
      } catch (error) {
        for (const [key, item] of [...entries.entries()]) {
          if (item.pluginId === pluginId) entries.delete(key);
        }
        for (const [key, item] of previous) entries.set(key, item);
        throw error;
      }
    },

    emit<E extends PluginAppEventName>(
      event: E,
      payload: AppEventPayloadMap[E],
    ): Promise<void> {
      const next = emitTail.then(() => dispatchEvent(event, payload));
      emitTail = next.catch(() => {});
      return next;
    },

    list() {
      return [...entries.values()]
        .map(({ pluginId, event }) => ({ pluginId, event }))
        .sort((a, b) =>
          compareText(`${a.pluginId}:${a.event}`, `${b.pluginId}:${b.event}`),
        );
    },
  };
}
