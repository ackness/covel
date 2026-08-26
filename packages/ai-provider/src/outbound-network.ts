import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { createConnectPinnedDispatcher } from "./adapters/http/dns-safety.js";

export type OutboundProxyMode = "direct" | "system" | "http" | "socks";

export interface OutboundProxyConfig {
  readonly mode: OutboundProxyMode;
  readonly url?: string;
}

export interface ConfigureOutboundProxyInput extends OutboundProxyConfig {
  /** Resolve Chromium's ordered proxy result for each concrete target URL. */
  readonly resolveSystemProxy?: SystemProxyResolver;
  /** @deprecated Compatibility path for shells without a per-request resolver. */
  readonly systemProxyUrl?: string;
}

export interface OutboundProxyStatus extends OutboundProxyConfig {
  readonly effective: "direct" | "proxy" | "system";
  readonly systemAvailable: boolean;
}

export type SystemProxyResolver = (
  targetUrl: string,
  signal?: AbortSignal,
) => Promise<string>;

export type SystemProxyRoute =
  | { readonly kind: "direct" }
  | { readonly kind: "proxy"; readonly url: string };

let currentConfig: OutboundProxyConfig = { mode: "direct" };
let currentSystemProxyUrl: string | undefined;
let currentSystemProxyResolver: SystemProxyResolver | undefined;
let proxyDispatcher: Dispatcher | undefined;
const systemProxyDispatchers = new Map<string, Dispatcher>();
let directDispatcher:
  ReturnType<typeof createConnectPinnedDispatcher> | undefined;

function createProxyDispatcher(url: string): Dispatcher {
  // Undici 8.7+ forwards plain HTTP with an absolute-form request target by
  // default. Covel's proxy contract uses CONNECT for every target protocol,
  // which also matches Chromium proxy routes and the pre-8.7 behavior.
  return new ProxyAgent({ uri: url, proxyTunnel: true });
}

function getDirectDispatcher(): ReturnType<
  typeof createConnectPinnedDispatcher
> {
  directDispatcher ??= createConnectPinnedDispatcher();
  return directDispatcher;
}

function customProxyUrl(mode: "http" | "socks", rawUrl: string): string {
  const value = rawUrl.trim();
  if (!value) throw new Error("Proxy address is required.");
  const withScheme = value.includes("://")
    ? value
    : `${mode === "socks" ? "socks5" : "http"}://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Proxy address must be a valid URL or host:port.");
  }
  const allowedProtocols =
    mode === "socks"
      ? new Set(["socks:", "socks5:"])
      : new Set(["http:", "https:"]);
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error(
      mode === "socks"
        ? "SOCKS proxy address must use socks:// or socks5://."
        : "HTTP proxy address must use http:// or https://.",
    );
  }
  if (mode === "socks" && parsed.protocol === "socks:") {
    parsed.protocol = "socks5:";
  }
  if (!parsed.hostname) throw new Error("Proxy address must include a host.");
  if (
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Proxy address cannot include a path, query, or fragment.");
  }
  return parsed.href.replace(/\/$/, "");
}

function systemProxyUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl?.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return undefined;
  }
  if (!["http:", "https:", "socks:", "socks5:"].includes(parsed.protocol)) {
    return undefined;
  }
  return parsed.href.replace(/\/$/, "");
}

/** Parse Chromium's ordered proxy list, retaining every supported fallback. */
export function parseSystemProxyRoutes(result: string): SystemProxyRoute[] {
  const routes: SystemProxyRoute[] = [];
  for (const rawEntry of result.split(";")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const [rawKind, ...addressParts] = entry.split(/\s+/);
    const kind = rawKind?.toUpperCase();
    const address = addressParts.join("").trim();
    if (kind === "DIRECT" && !address) {
      routes.push({ kind: "direct" });
      continue;
    }
    const scheme =
      kind === "PROXY" || kind === "HTTP"
        ? "http"
        : kind === "HTTPS"
          ? "https"
          : kind === "SOCKS5"
            ? "socks5"
            : undefined;
    // Chromium's SOCKS/SOCKS4 token means SOCKSv4, which Undici cannot use.
    if (!scheme || !address) continue;
    try {
      const url = new URL(`${scheme}://${address}`);
      if (
        !url.hostname ||
        (url.pathname && url.pathname !== "/") ||
        url.search ||
        url.hash
      )
        continue;
      routes.push({ kind: "proxy", url: url.href.replace(/\/$/, "") });
    } catch {
      // A malformed or unsupported entry does not discard later fallbacks.
    }
  }
  if (routes.length === 0) {
    throw new Error("System proxy resolution returned no supported route.");
  }
  return routes;
}

function getSystemProxyDispatcher(url: string): Dispatcher {
  const existing = systemProxyDispatchers.get(url);
  if (existing) {
    systemProxyDispatchers.delete(url);
    systemProxyDispatchers.set(url, existing);
    return existing;
  }
  const dispatcher = createProxyDispatcher(url);
  systemProxyDispatchers.set(url, dispatcher);
  if (systemProxyDispatchers.size > 16) {
    const oldest = systemProxyDispatchers.entries().next().value as
      [string, Dispatcher] | undefined;
    if (oldest) {
      systemProxyDispatchers.delete(oldest[0]);
      void oldest[1].close().catch(() => undefined);
    }
  }
  return dispatcher;
}

function closeSystemProxyDispatchers(): void {
  for (const dispatcher of systemProxyDispatchers.values()) {
    void dispatcher.close().catch(() => undefined);
  }
  systemProxyDispatchers.clear();
}

export function normalizeOutboundProxyConfig(
  input: OutboundProxyConfig,
): OutboundProxyConfig {
  switch (input.mode) {
    case "direct":
    case "system":
      return { mode: input.mode };
    case "http":
    case "socks":
      return {
        mode: input.mode,
        url: customProxyUrl(input.mode, input.url ?? ""),
      };
    default:
      throw new Error("Proxy mode must be direct, system, http, or socks.");
  }
}

/** Apply a new process-wide transport selection for framework-owned requests. */
export function configureOutboundProxy(
  input: ConfigureOutboundProxyInput,
): OutboundProxyStatus {
  const normalized = normalizeOutboundProxyConfig(input);
  const nextSystemProxyUrl = systemProxyUrl(input.systemProxyUrl);
  const effectiveProxyUrl =
    normalized.mode === "system" && !input.resolveSystemProxy
      ? nextSystemProxyUrl
      : normalized.url;
  const nextDispatcher = effectiveProxyUrl
    ? createProxyDispatcher(effectiveProxyUrl)
    : undefined;
  const previous = proxyDispatcher;

  currentConfig = normalized;
  currentSystemProxyUrl = nextSystemProxyUrl;
  currentSystemProxyResolver = input.resolveSystemProxy;
  proxyDispatcher = nextDispatcher;
  closeSystemProxyDispatchers();
  if (previous) void previous.close().catch(() => undefined);
  return getOutboundProxyStatus();
}

export function getOutboundProxyStatus(): OutboundProxyStatus {
  const dynamicSystem =
    currentConfig.mode === "system" && currentSystemProxyResolver !== undefined;
  return {
    ...currentConfig,
    effective: dynamicSystem ? "system" : proxyDispatcher ? "proxy" : "direct",
    systemAvailable:
      currentSystemProxyResolver !== undefined ||
      currentSystemProxyUrl !== undefined,
  };
}

function runtimeFetch(): typeof undiciFetch | typeof globalThis.fetch {
  // Existing unit tests intentionally replace global fetch. Production and
  // development always use the npm Undici implementation paired with the npm
  // dispatcher, avoiding Electron's built-in Undici version boundary.
  return process.env.NODE_ENV === "test" ? globalThis.fetch : undiciFetch;
}

function actionableFetchError(error: unknown): Error | unknown {
  let cause: unknown = error;
  let detail: Error | undefined;
  let code: string | undefined;
  for (let depth = 0; cause instanceof Error && depth < 6; depth++) {
    if (cause.message.startsWith("SSRF policy rejected")) return cause;
    if (depth > 0) detail = cause;
    const candidateCode = (cause as Error & { code?: unknown }).code;
    if (typeof candidateCode === "string" && candidateCode)
      code = candidateCode;
    cause = cause.cause;
  }
  if (!(error instanceof Error) || !detail) return error;
  const prefix = code ? `${code}: ` : "";
  return new Error(`${error.message}: ${prefix}${detail.message}`, {
    cause: error,
  });
}

/** Fetch with an explicitly compatible Undici dispatcher and useful causes. */
export async function fetchWithDispatcher(
  input: string | URL,
  init: RequestInit,
  dispatcher: Dispatcher,
): Promise<Response> {
  try {
    const fetchImpl = runtimeFetch();
    return (await fetchImpl(
      input as never,
      {
        ...init,
        dispatcher,
      } as never,
    )) as unknown as Response;
  } catch (error) {
    throw actionableFetchError(error);
  }
}

/** Framework-owned provider/model-database fetch honoring desktop proxy mode. */
function canReplayBody(body: RequestInit["body"]): boolean {
  if (body == null) return true;
  if (typeof body !== "object") return true;
  return !("getReader" in body || "pipe" in body);
}

function canFallbackAfter(
  error: unknown,
  signal?: AbortSignal | null,
): boolean {
  if (signal?.aborted) return false;
  const fallbackCodes = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_PRX_CONN",
    // Undici reports destination-side SOCKS5 connectivity failures with
    // protocol reply codes instead of the corresponding Node network codes.
    // These are safe to advance past when Chromium supplied another route.
    "UND_ERR_SOCKS5_REPLY_3", // network unreachable
    "UND_ERR_SOCKS5_REPLY_4", // host unreachable
    "UND_ERR_SOCKS5_REPLY_5", // connection refused
    "UND_ERR_SOCKS5_REPLY_6", // TTL expired
  ]);
  let cause = error;
  for (let depth = 0; cause instanceof Error && depth < 8; depth++) {
    if (cause.name === "AbortError") return false;
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === "string" && fallbackCodes.has(code)) return true;
    cause = cause.cause;
  }
  return false;
}

async function fetchWithSystemProxy(
  input: string | URL,
  init: RequestInit,
  resolver: SystemProxyResolver,
): Promise<Response> {
  const targetUrl = input instanceof URL ? input.href : new URL(input).href;
  const routes = parseSystemProxyRoutes(
    await resolver(targetUrl, init.signal ?? undefined),
  );
  let lastError: unknown;
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index]!;
    const dispatcher =
      route.kind === "direct"
        ? getDirectDispatcher()
        : getSystemProxyDispatcher(route.url);
    try {
      return await fetchWithDispatcher(input, init, dispatcher);
    } catch (error) {
      lastError = error;
      if (
        index === routes.length - 1 ||
        !canFallbackAfter(error, init.signal)
      ) {
        throw error;
      }
      if (!canReplayBody(init.body)) {
        throw new Error(
          "System proxy fallback cannot replay a streaming request body.",
          { cause: error },
        );
      }
    }
  }
  throw lastError;
}

export function outboundFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (currentConfig.mode === "system" && currentSystemProxyResolver) {
    return fetchWithSystemProxy(input, init, currentSystemProxyResolver);
  }
  return fetchWithDispatcher(
    input,
    init,
    proxyDispatcher ?? getDirectDispatcher(),
  );
}

export async function resetOutboundProxyForTests(): Promise<void> {
  const dispatchers = [proxyDispatcher, directDispatcher].filter(
    (dispatcher): dispatcher is Dispatcher => dispatcher !== undefined,
  );
  proxyDispatcher = undefined;
  const dynamicDispatchers = [...systemProxyDispatchers.values()];
  systemProxyDispatchers.clear();
  directDispatcher = undefined;
  currentConfig = { mode: "direct" };
  currentSystemProxyUrl = undefined;
  currentSystemProxyResolver = undefined;
  await Promise.all(
    [...dispatchers, ...dynamicDispatchers].map((dispatcher) =>
      dispatcher.close(),
    ),
  );
}
