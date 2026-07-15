/**
 * Centralized security fail-fast (audit S-13).
 *
 * Called once from `app.ts` at boot, before the server starts listening.
 * Hosted tiers must not come up with an unsafe posture; T1 self-deploy /
 * desktop / dev (`DEPLOYMENT_TIER=self` or unset) is a strict no-op.
 */

import type { readRuntimeEnv } from "@covel/shared";

type RuntimeEnv = ReturnType<typeof readRuntimeEnv>;

/**
 * Throws (aborting boot) when a hosted deployment tier is missing a required
 * security control:
 *
 * - `commercial` and `demo`: a real `COVEL_MEDIA_TOKEN_SECRET` (signed media
 *   URLs; an ephemeral per-boot secret invalidates every outstanding URL on
 *   restart, and the media-token module hard-fails lazily in production —
 *   failing at boot surfaces the misconfiguration immediately).
 * - `commercial` and `demo`: the operator bearer token
 *   (`COVEL_DESKTOP_REST_TOKEN`). Session-scoped routes are authorized by
 *   per-session owner tokens (minted at session creation and hard-enforced
 *   on `demo`/`commercial` — see `routes/api/session/session-guard.ts`),
 *   but session CREATION (C-02) and cross-session admin surfaces (session
 *   listing, config/install) require the operator token; without it a
 *   hosted deployment could never mint a session at all — fail loudly at
 *   boot instead of shipping a silently bricked (or unauthenticated) host.
 * - `commercial` only: an explicit `CORS_ORIGIN` allowlist.
 */
export function validateSecurityPosture(env: RuntimeEnv): void {
  const tier = env.deploymentTier;
  const problems: string[] = [];

  if (
    (tier === "commercial" || tier === "demo") &&
    !env.mediaTokenSecret?.trim()
  ) {
    problems.push(
      "COVEL_MEDIA_TOKEN_SECRET must be set (signed media URLs need a stable secret on shared hosts)",
    );
  }

  if (
    (tier === "commercial" || tier === "demo") &&
    !env.desktopRestToken?.trim()
  ) {
    problems.push(
      `authentication is not configured — DEPLOYMENT_TIER=${tier} requires the operator token for session creation and admin surfaces (set COVEL_DESKTOP_REST_TOKEN or deploy behind an authenticating layer)`,
    );
  }

  if (tier === "commercial" && env.corsOrigins.length === 0) {
    problems.push(
      "CORS_ORIGIN must list explicit allowed origins (the localhost dev defaults are not a commercial posture)",
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `[security-posture] Refusing to start with DEPLOYMENT_TIER=${tier}:\n  - ${problems.join("\n  - ")}`,
    );
  }
}
