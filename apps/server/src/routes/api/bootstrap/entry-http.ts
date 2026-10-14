import { AsyncLocalStorage } from "node:async_hooks";
import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
import { enforceHttpPermissions, type PluginAPI } from "@covel/runtime";
import type { HttpPermissionDecl } from "@covel/shared";

type PluginHttp = PluginAPI["http"];

/**
 * The endpoint of the model slot a plugin's wire is serving right now. The
 * player configured it, not the plugin, so the wire may reach it although
 * the package did not declare it.
 */
const wireEndpoints = new AsyncLocalStorage<{
  readonly pluginId: string;
  readonly origin: string;
}>();

function originOf(input: string | URL): string | undefined {
  try {
    return new URL(typeof input === "string" ? input : input.href).origin;
  } catch {
    return undefined;
  }
}

/** Run `fn` with the endpoint in the wire's first argument (its slot config). */
export function withWireEndpoint<T>(
  pluginId: string,
  config: unknown,
  fn: () => T,
): T {
  const baseUrl =
    config && typeof config === "object"
      ? Reflect.get(config, "baseUrl")
      : undefined;
  const origin = typeof baseUrl === "string" ? originOf(baseUrl) : undefined;
  return origin ? wireEndpoints.run({ pluginId, origin }, fn) : fn();
}

/**
 * `covel.http` of one package. A community package reaches only the origins
 * and methods its `PLUGIN.md` declares under `permissions.http` (the root and
 * every runtime), plus the endpoint of a slot its wire is serving. The SSRF
 * guard inside `fetchWithRetry` runs either way.
 */
export function createEntryHttp(
  pluginId: string,
  isCommunity: boolean,
  httpPermissions: readonly HttpPermissionDecl[],
): PluginHttp {
  const raw: PluginHttp = {
    fetchWithRetry,
    validateBaseUrl: validateBaseUrlForPlugin,
  };
  if (!isCommunity) return raw;
  const checked = enforceHttpPermissions(raw, {
    isCommunity,
    httpPermissions,
    runtimeId: pluginId,
  });
  return {
    validateBaseUrl: raw.validateBaseUrl,
    fetchWithRetry(input, init) {
      const endpoint = wireEndpoints.getStore();
      if (
        endpoint?.pluginId === pluginId &&
        originOf(input) === endpoint.origin
      )
        return raw.fetchWithRetry(input, init);
      return checked.fetchWithRetry(input, init);
    },
  };
}

/** `http` bound to a call's signal, for a service handler's `context.utils`. */
export function withCallSignal(
  http: PluginHttp,
  signal: AbortSignal,
): PluginHttp {
  return {
    validateBaseUrl: (url) => http.validateBaseUrl(url),
    fetchWithRetry: (input, init) =>
      http.fetchWithRetry(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      }),
  };
}
