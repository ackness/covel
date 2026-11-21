/**
 * Pure origin-trust helpers shared by the main-frame navigation guard
 * (windows.ts) and the sensitive-IPC guard (ipc-handlers.ts). Kept free of any
 * Electron import so the security branch stays unit-testable
 * (see trusted-origin.selfcheck.ts).
 *
 * The app only ever runs on a loopback http origin: the local sidecar
 * (http://127.0.0.1:<port>) in production, the Vite dev server
 * (http://localhost:5173) in dev. Anything else reaching a main-frame
 * navigation or a key/secret IPC is an XSS / redirect pivot that could then
 * call `covelIpc` and read raw provider keys — it must be refused.
 */

const UNTRUSTED_APP_PATH_PREFIXES = [
  "/plugin-assets",
  "/plugin-frame.html",
] as const;

const ALLOWED_APP_PERMISSIONS = new Set<string>(["clipboard-sanitized-write"]);

function matchesUntrustedAppPath(pathname: string): boolean {
  const normalized = pathname
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
  const withLeadingSlash = normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
  const firstSegment =
    withLeadingSlash
      .slice(1)
      .split("/", 1)[0]
      ?.replace(/[. ]+$/, "") ?? "";
  return UNTRUSTED_APP_PATH_PREFIXES.some(
    (prefix) => `/${firstSegment}` === prefix,
  );
}

/**
 * True when a pathname targets an untrusted plugin-hosted document on the app
 * origin (`/plugin-assets/...` or `/plugin-frame.html`). Checks both raw and
 * percent-decoded/normalized forms and fails closed on malformed encoding.
 */
export function isUntrustedAppPath(pathname: string): boolean {
  if (matchesUntrustedAppPath(pathname)) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  if (matchesUntrustedAppPath(decoded)) return true;
  const collapsed = decoded.replace(/\\+/g, "/").replace(/\/+/g, "/");
  const candidate = collapsed.startsWith("/") ? collapsed : `/${collapsed}`;
  try {
    const normalizedDecoded = new URL(candidate, "http://127.0.0.1").pathname;
    return matchesUntrustedAppPath(normalizedDecoded);
  } catch {
    return true;
  }
}

/** Return the origin iff `rawUrl` parses to a loopback **http** URL, else null. */
export function loopbackHttpOrigin(
  rawUrl: string | null | undefined,
): string | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  // URL.hostname keeps the brackets for IPv6 literals (e.g. "[::1]").
  const host = parsed.hostname;
  const isLoopback =
    host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  return isLoopback ? parsed.origin : null;
}

/** True when a loopback http URL targets a plugin-hosted document path. */
export function isUntrustedAppUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl || !loopbackHttpOrigin(rawUrl)) return false;
  return isUntrustedAppPath(new URL(rawUrl).pathname);
}

function trustedAppOrigin(rawUrl: string | null | undefined): string | null {
  const origin = loopbackHttpOrigin(rawUrl);
  if (!origin || !rawUrl) return null;
  return isUntrustedAppPath(new URL(rawUrl).pathname) ? null : origin;
}

/**
 * True iff `candidateUrl` shares the exact loopback-http origin of `trustedUrl`
 * (the main window's committed app page) and neither URL targets a plugin-hosted
 * document path (`/plugin-assets/...`, `/plugin-frame.html`). Fail-closed: a
 * data:/file:/https, cross-origin, or plugin-hosted candidate — or a non-app
 * trusted page (e.g. the data: URL splash) — returns false.
 */
export function isSameTrustedOrigin(
  trustedUrl: string | null | undefined,
  candidateUrl: string | null | undefined,
): boolean {
  const trusted = trustedAppOrigin(trustedUrl);
  if (!trusted) return false;
  return trustedAppOrigin(candidateUrl) === trusted;
}

/**
 * The address to load once the sidecar answers on `port`. A window that shows
 * an app page stays on that page: path, query and fragment carry over and only
 * the port changes, so a restarted sidecar does not send the player from a
 * running session back to the world list. Any other page (the splash, a blank
 * window, or a plugin-hosted path) opens the start page.
 */
export function appUrlOnPort(
  currentUrl: string | null | undefined,
  port: number,
): string {
  const origin = `http://127.0.0.1:${port}`;
  if (!currentUrl || !trustedAppOrigin(currentUrl)) {
    return `${origin}/session`;
  }
  const current = new URL(currentUrl);
  return `${origin}${current.pathname}${current.search}${current.hash}`;
}

const SPLASH_DATA_URL_PREFIX = "data:text/html;charset=utf-8,";

/**
 * The startup recovery page is a main-process-authored data document. Trust it
 * only when the sender URL exactly matches the currently committed splash;
 * callers must additionally require the sender to be the main frame.
 */
export function isSameStartupSplashDocument(
  committedUrl: string | null | undefined,
  candidateUrl: string | null | undefined,
): boolean {
  return Boolean(
    committedUrl &&
    candidateUrl &&
    committedUrl.startsWith(SPLASH_DATA_URL_PREFIX) &&
    candidateUrl === committedUrl,
  );
}

export interface TrustedIpcFrame {
  readonly isMainFrame: boolean;
  readonly url: string | null | undefined;
  readonly origin: string | null | undefined;
}

/**
 * True iff an IPC sender frame is the main frame of a trusted app document:
 * non-opaque `origin` matching both `frame.url`'s loopback origin and the main
 * window's committed trusted origin, excluding plugin-hosted document paths.
 */
export function isTrustedIpcFrame(
  frame: TrustedIpcFrame,
  trustedUrl: string | null | undefined,
): boolean {
  if (!frame.isMainFrame) return false;
  if (!frame.origin || frame.origin === "null") return false;
  const expectedOrigin = trustedAppOrigin(trustedUrl);
  if (!expectedOrigin) return false;
  const candidateOrigin = trustedAppOrigin(frame.url);
  if (!candidateOrigin || candidateOrigin !== expectedOrigin) return false;
  return frame.origin === candidateOrigin;
}

/**
 * Recovery IPC allows either a trusted app frame or the committed main-frame
 * startup splash `data:` document (whose RFC 6454 origin is `"null"`).
 */
export function isTrustedRecoveryIpcFrame(
  frame: TrustedIpcFrame,
  trustedUrl: string | null | undefined,
): boolean {
  if (isTrustedIpcFrame(frame, trustedUrl)) return true;
  return (
    frame.isMainFrame &&
    frame.origin === "null" &&
    isSameStartupSplashDocument(trustedUrl, frame.url)
  );
}

export interface SessionPermissionCheck {
  readonly permission: string;
  readonly isMainFrame: boolean;
  readonly requestingUrl: string | null | undefined;
  readonly requestingOrigin: string | null | undefined;
  readonly trustedUrl: string | null | undefined;
}

/**
 * Fail-closed browser permission policy for the desktop Electron session.
 * Denies all permissions by default; allows only `clipboard-sanitized-write`
 * (for in-app copy buttons) from the trusted main-frame app document.
 */
export function isAllowedSessionPermission({
  permission,
  isMainFrame,
  requestingUrl,
  requestingOrigin,
  trustedUrl,
}: SessionPermissionCheck): boolean {
  if (!ALLOWED_APP_PERMISSIONS.has(permission)) return false;
  return isTrustedIpcFrame(
    {
      isMainFrame,
      url: requestingUrl,
      origin: loopbackHttpOrigin(requestingOrigin),
    },
    trustedUrl,
  );
}
