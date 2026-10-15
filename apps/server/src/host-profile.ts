/**
 * The deployment form of this server, decided once at start.
 *
 * `DEPLOYMENT_TIER` (`self` | `demo` | `commercial`) and the store the server
 * runs on choose the form; the operator token (`COVEL_DESKTOP_REST_TOKEN`) and
 * a few switches fill in its rules. `app.ts` resolves the profile before it
 * mounts a route and puts it in every request's context. Route guards, the
 * media routes, the server settings, a request's own model settings and the
 * trace retention ask the profile; none of them reads those variables.
 * `@covel/ai-provider` gets its part as a parameter
 * (`configureProviderHostPolicy`).
 *
 * Forms:
 *
 * - `personal`: `DEPLOYMENT_TIER=self` (the default) on a store that keeps
 *   data. The desktop app, a self-hosted web app, `pnpm dev`. One player owns
 *   the server: no route asks for a token, except that the desktop shell's
 *   per-launch token guards its config and file APIs when the shell set one.
 *   Listening on loopback and the Host check (`middleware/host-guard.ts`) are
 *   the network boundary.
 * - `browser-private`: `self` with `NODE_ENV=production` on a MemoryStore.
 *   Each player's data lives in their browser; the server holds transient
 *   mirrors. A session needs its owner token and shared worlds need the
 *   operator token; anyone may create a session. The official web app will
 *   be built on this form. It is not supported yet: its remaining rules (the
 *   global entries F-005 lists) are cells in {@link accessRules}.
 * - `hosted`: `demo` / `commercial`, a shared host run by one operator. A
 *   session needs its owner token; creating, forking and listing sessions,
 *   global writes, model probes and community code need the operator token.
 *   `commercial` also keeps media cleanup closed and needs CORS origins.
 *
 * An unknown tier never reaches this module: the shared parser throws on it,
 * which stops the start. {@link resolveHostProfile} refuses a hosted tier
 * without its secrets and settings the chosen form would silently ignore.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { readRuntimeEnv, type DeploymentTier } from "@covel/shared";
import type { ProviderHostPolicy } from "@covel/ai-provider";
import type { StoreBackend } from "@covel/store";
import { errorBody } from "./api-error.js";

type RuntimeEnv = ReturnType<typeof readRuntimeEnv>;

export type HostForm = "personal" | "browser-private" | "hosted";

/**
 * What a request can ask of the host. Every API route names the actions it
 * needs (`tests/bootstrap/route-access.test.ts` keeps the list).
 *
 * | Action               | What it covers                                                      |
 * | -------------------- | ------------------------------------------------------------------- |
 * | `session.access`     | read or change one session                                          |
 * | `session.create`     | create a session, or fork one into a new session                    |
 * | `session.list`       | list every session on the server                                    |
 * | `world.write`        | write the shared world catalog                                      |
 * | `world.generate`     | generate, revise or translate a world with the server's models      |
 * | `plugin.community`   | approve, enable or run a community plugin's server code             |
 * | `server.diagnostics` | read model endpoints, config paths, load errors, key availability   |
 * | `model.probe`        | list a provider's models, ping a model                              |
 * | `model-db.refresh`   | download a new model database                                       |
 * | `server.settings`    | store a server-scoped setting                                       |
 * | `host.config`        | the desktop shell's settings, keys, proxy, data root, update check  |
 * | `host.files`         | write packages or raw config files: install, uninstall, reload      |
 * | `media.cleanup`      | delete media bytes no session uses                                  |
 * | `media.library`      | the media library across sessions                                   |
 */
export const HOST_ACTIONS = [
  "session.access",
  "session.create",
  "session.list",
  "world.write",
  "world.generate",
  "plugin.community",
  "server.diagnostics",
  "model.probe",
  "model-db.refresh",
  "server.settings",
  "host.config",
  "host.files",
  "media.cleanup",
  "media.library",
] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];

/** Actions that do not belong to one session; {@link requireAccess} decides them. */
export type HostGlobalAction = Exclude<HostAction, "session.access">;

/** The answer a refused request gets. */
export interface HostDenial {
  readonly status: 401 | 403 | 503;
  readonly code: string;
  readonly message: string;
}

export type HostAccessRule =
  /** Anyone who reaches the server. */
  | { readonly kind: "open" }
  /** The session's owner token or the operator token (`session-guard.ts`). */
  | { readonly kind: "owner"; readonly denial: HostDenial }
  /**
   * The operator token. `bearerOnly`: only from `Authorization: Bearer`;
   * otherwise also from `X-Session-Token` or `?session_token=`, the channels a
   * session token uses. Refused when the server has no operator token.
   */
  | {
      readonly kind: "token";
      readonly bearerOnly: boolean;
      readonly denial: HostDenial;
    }
  /** Nobody. */
  | { readonly kind: "closed"; readonly denial: HostDenial };

export interface HostProfile {
  readonly tier: DeploymentTier;
  readonly form: HostForm;
  readonly access: Readonly<Record<HostAction, HostAccessRule>>;
  /** True when `token` is this server's operator token; false when it has none. */
  readonly isOperatorToken: (token: string) => boolean;
  readonly network: {
    /**
     * Answer only requests whose Host names this server, which refuses
     * DNS-rebound pages. Off on hosted tiers, which authenticate instead.
     */
    readonly checkHost: boolean;
    /** Names besides the loopback ones the server answers to. */
    readonly allowedHosts: readonly string[];
  };
  /** What a request's own model settings may do. */
  readonly credentials: {
    /**
     * How far a request's model configuration (`X-Slot-Config`) may change a
     * model's capabilities: everything on a personal host, only narrowing on
     * a shared one.
     */
    readonly capabilityOverrides: "full" | "restrict-only";
    /** Passed to `@covel/ai-provider` at start. */
    readonly provider: ProviderHostPolicy;
  };
  /** What the server keeps, and who decides how long. */
  readonly retention: {
    /** A player's server-scoped settings (trace retention) count. */
    readonly playerServerSettings: boolean;
    /** `POST /api/media/cleanup` is switched on (`COVEL_MEDIA_CLEANUP_ENABLED`). */
    readonly mediaCleanup: boolean;
  };
}

/** Facts about the running server that the environment alone does not give. */
export interface HostFacts {
  /** Backend of the DataStore the server actually runs on. */
  readonly storeBackend: StoreBackend;
}

export const OPERATOR_TOKEN_REQUIRED_CODE = "operator_token_required";

/**
 * Constant-time string comparison. Both inputs are hashed to fixed-length
 * digests, so `timingSafeEqual` never throws on a length mismatch and the
 * comparison leaks neither content nor length.
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

interface AccessFacts {
  readonly tier: DeploymentTier;
  readonly form: HostForm;
  /** A production MemoryStore: transient mirrors everyone shares. */
  readonly sharedMirrors: boolean;
  readonly production: boolean;
  readonly operatorTokenSet: boolean;
  readonly debugRoutes: boolean;
  readonly installApiEnabled: boolean;
}

/**
 * The access table: one rule per action for the facts of this server.
 *
 * Fixing F-005 (the official web app's global entries) means changing the
 * `browser-private` answers below, which today stay as open as `personal`
 * for `plugin.community`, `server.diagnostics`, `model.probe`,
 * `model-db.refresh`, `server.settings` and `host.config`.
 */
function accessRules(f: AccessFacts): Record<HostAction, HostAccessRule> {
  const open: HostAccessRule = { kind: "open" };
  const operatorDenial = (
    message = "Operator token required on this tier",
  ): HostDenial => ({
    status: 401,
    code: OPERATOR_TOKEN_REQUIRED_CODE,
    message,
  });
  const operator = (message?: string): HostAccessRule => ({
    kind: "token",
    bearerOnly: false,
    denial: operatorDenial(message),
  });
  const closed = (
    status: HostDenial["status"],
    code: string,
    message: string,
  ): HostAccessRule => ({ kind: "closed", denial: { status, code, message } });
  /** The desktop shell's per-launch token, from `Authorization` only. */
  const desktopToken: HostAccessRule = {
    kind: "token",
    bearerOnly: true,
    denial: {
      status: 401,
      code: "desktop_rest_token_invalid",
      message: "Desktop REST token missing or invalid",
    },
  };
  const hosted = f.form === "hosted";
  const personal = f.form === "personal";
  const operatorWhenHosted = hosted ? operator() : open;
  const desktopConfig = f.operatorTokenSet ? desktopToken : open;

  return {
    "session.access": personal
      ? open
      : {
          kind: "owner",
          denial: {
            status: 401,
            code: "session_owner_required",
            message: "Session owner token missing or invalid",
          },
        },
    "session.create": hosted
      ? operator("Operator token required to create sessions on this tier")
      : open,
    // Shared mirrors are listed to nobody: the only callers would be other
    // players. The route answers an empty list. ENABLE_DEBUG_PAGE keeps the
    // listing for the /debug tooling.
    "session.list":
      f.sharedMirrors && !f.debugRoutes
        ? closed(403, "session_list_unavailable", "Sessions are not listed")
        : operatorWhenHosted,
    "world.write": personal
      ? open
      : operator("Operator token required to modify shared worlds"),
    "world.generate": operatorWhenHosted,
    "plugin.community": operatorWhenHosted,
    "server.diagnostics": operatorWhenHosted,
    "model.probe": operatorWhenHosted,
    "model-db.refresh": operatorWhenHosted,
    // On a hosted tier these settings are the operator's, set through the
    // environment; a write is refused whatever the caller presents.
    "server.settings": hosted
      ? closed(
          403,
          "server_settings_operator_only",
          "Server settings are set by the operator of this server",
        )
      : desktopConfig,
    "host.config": desktopConfig,
    // A production server without the token writes packages to disk only
    // when the operator opted in (COVEL_INSTALL_API_ENABLED=1).
    "host.files": hosted
      ? { kind: "token", bearerOnly: true, denial: operatorDenial() }
      : f.operatorTokenSet
        ? desktopToken
        : f.production && !f.installApiEnabled
          ? closed(
              403,
              "install_api_disabled",
              "Install API is disabled in production",
            )
          : open,
    // No admin authentication is wired for commercial; the closed rule makes
    // that explicit to callers.
    "media.cleanup":
      f.tier === "commercial"
        ? closed(
            503,
            "unavailable",
            "cleanup endpoint not available in this deployment tier",
          )
        : operatorWhenHosted,
    // Only where one player owns everything the MediaStore holds: the other
    // forms share it between owners and keep no per-owner media index.
    "media.library": personal
      ? open
      : closed(
          503,
          "unavailable",
          "media library is not available in this deployment",
        ),
  };
}

/**
 * The profile for this environment and store, without the start checks of
 * {@link resolveHostProfile}.
 */
export function deriveHostProfile(
  env: RuntimeEnv,
  facts: HostFacts,
): HostProfile {
  const tier = env.deploymentTier;
  const hosted = tier !== "self";
  const production = env.nodeEnv === "production";
  const sharedMirrors = production && facts.storeBackend === "memory";
  const form: HostForm = hosted
    ? "hosted"
    : sharedMirrors
      ? "browser-private"
      : "personal";
  const operatorToken = env.desktopRestToken;
  return {
    tier,
    form,
    access: accessRules({
      tier,
      form,
      sharedMirrors,
      production,
      operatorTokenSet: operatorToken !== undefined,
      debugRoutes: env.debugRoutes,
      installApiEnabled: env.installApiEnabled,
    }),
    isOperatorToken: (token) =>
      operatorToken !== undefined && safeEqual(token, operatorToken),
    network: { checkHost: !hosted, allowedHosts: env.allowedHosts },
    credentials: {
      capabilityOverrides: hosted ? "restrict-only" : "full",
      provider: { localNetwork: !hosted, sessionlessCommunityWires: !hosted },
    },
    retention: {
      playerServerSettings: !hosted,
      mediaCleanup: env.mediaCleanupEnabled,
    },
  };
}

/**
 * Settings this environment cannot run with: a hosted tier without the
 * secrets it needs, and values the chosen form would silently ignore.
 */
export function hostProfileProblems(env: RuntimeEnv): string[] {
  const tier = env.deploymentTier;
  const hosted = tier !== "self";
  const problems: string[] = [];

  // Signed media URLs: an ephemeral per-boot secret invalidates every
  // outstanding URL on restart, and the media-token module refuses it in
  // production anyway. Fail at start instead of at the first image.
  if (hosted && !env.mediaTokenSecret?.trim()) {
    problems.push(
      "COVEL_MEDIA_TOKEN_SECRET must be set (signed media URLs need a stable secret on shared hosts)",
    );
  }
  // Creating a session needs the operator token on a hosted tier: without
  // one the host could never mint a session.
  if (hosted && !env.desktopRestToken?.trim()) {
    problems.push(
      `authentication is not configured — DEPLOYMENT_TIER=${tier} requires the operator token for session creation and admin surfaces (set COVEL_DESKTOP_REST_TOKEN or deploy behind an authenticating layer)`,
    );
  }
  if (tier === "commercial" && env.corsOrigins.length === 0) {
    problems.push(
      "CORS_ORIGIN must list explicit allowed origins (the localhost dev defaults are not a commercial posture)",
    );
  }
  if (hosted && env.allowedHosts.length > 0) {
    problems.push(
      `COVEL_ALLOWED_HOSTS has no effect with DEPLOYMENT_TIER=${tier}: the Host check runs only on the self tier, and a hosted tier authenticates requests instead. Remove it, or use DEPLOYMENT_TIER=self`,
    );
  }
  if (tier === "commercial" && env.mediaCleanupEnabled) {
    problems.push(
      "COVEL_MEDIA_CLEANUP_ENABLED cannot be used with DEPLOYMENT_TIER=commercial: the cleanup endpoint stays closed on this tier. Remove it",
    );
  }
  return problems;
}

/**
 * Resolve the profile at start. Throws, which stops the start, when
 * {@link hostProfileProblems} finds anything; the message lists every problem.
 */
export function resolveHostProfile(
  env: RuntimeEnv,
  facts: HostFacts,
): HostProfile {
  const problems = hostProfileProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `[host-profile] Refusing to start with DEPLOYMENT_TIER=${env.deploymentTier}:\n  - ${problems.join("\n  - ")}`,
    );
  }
  return deriveHostProfile(env, facts);
}

/** Put the start's profile into every request's context. */
export function hostProfileMiddleware(profile: HostProfile): MiddlewareHandler {
  return async (c, next) => {
    c.set("hostProfile", profile);
    await next();
  };
}

/**
 * The profile this request is served under: the one `app.ts` resolved at
 * start. A route module mounted without the server's composition root (a test
 * that mounts one route file) has none in its context and gets the profile
 * the start would have resolved, from the environment and the injected store.
 */
export function hostProfileOf(c: Context): HostProfile {
  const resolved = c.get("hostProfile");
  if (resolved) return resolved;
  const env = readRuntimeEnv();
  return deriveHostProfile(env, {
    storeBackend: c.get("storeBackend") ?? env.storeBackend,
  });
}

/** The token from an `Authorization: Bearer <token>` header. */
export function bearerToken(c: Context): string | undefined {
  const header = (c.req.header("authorization") ?? "").trim();
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || undefined;
}

/**
 * The token a caller presents for a session or as the operator:
 * `Authorization: Bearer`, `X-Session-Token`, or `?session_token=` (an
 * EventSource cannot set headers).
 */
export function presentedToken(c: Context): string | undefined {
  const bearer = bearerToken(c);
  if (bearer) return bearer;
  const header = c.req.header("x-session-token")?.trim();
  if (header) return header;
  return c.req.query("session_token")?.trim() || undefined;
}

function denialFor(c: Context, action: HostGlobalAction): HostDenial | null {
  const profile = hostProfileOf(c);
  const rule = profile.access[action];
  switch (rule.kind) {
    case "open":
      return null;
    case "token": {
      const token = rule.bearerOnly ? bearerToken(c) : presentedToken(c);
      return token !== undefined && profile.isOperatorToken(token)
        ? null
        : rule.denial;
    }
    case "owner":
      // A per-session rule; checkSessionOwner decides it with the session.
      throw new Error(`Host action ${action} needs a session to decide`);
    case "closed":
      return rule.denial;
  }
}

/** True when this request may perform `action` on this host. */
export function allowsAccess(c: Context, action: HostGlobalAction): boolean {
  return denialFor(c, action) === null;
}

/**
 * Undefined when this request may perform `action`; otherwise the refusal to
 * return as it is.
 */
export function requireAccess(
  c: Context,
  action: HostGlobalAction,
): Response | undefined {
  const denial = denialFor(c, action);
  return denial
    ? c.json(errorBody(denial.message, { code: denial.code }), denial.status)
    : undefined;
}

/** {@link requireAccess} as route middleware. */
export function accessGuard(action: HostGlobalAction): MiddlewareHandler {
  return async (c, next) => {
    const denied = requireAccess(c, action);
    if (denied) return denied;
    await next();
  };
}

const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Warnings for a bind address that exposes this profile further than its
 * boundary covers. A public bind is legitimate (containers, an upstream
 * authenticating proxy), so these warn rather than refuse.
 */
export function bindWarnings(profile: HostProfile, bindHost: string): string[] {
  if (LOOPBACK_BINDS.has(bindHost)) return [];
  const warnings: string[] = [];
  if (profile.access["session.access"].kind === "open") {
    warnings.push(
      `[security] Listening on ${bindHost} with DEPLOYMENT_TIER=${profile.tier}: ` +
        "session and plugin APIs are UNAUTHENTICATED. Anyone who can reach this port " +
        "can control sessions and spend configured provider keys. Keep " +
        "COVEL_BIND_HOST=127.0.0.1, or set DEPLOYMENT_TIER=demo|commercial with " +
        "COVEL_DESKTOP_REST_TOKEN to enforce owner tokens.",
    );
  }
  if (profile.network.checkHost && profile.network.allowedHosts.length === 0) {
    warnings.push(
      `[security] Listening on ${bindHost}, but requests are answered only when ` +
        "their Host is localhost, 127.0.0.1 or [::1]. List any other name this " +
        "server is opened by in COVEL_ALLOWED_HOSTS.",
    );
  }
  return warnings;
}
