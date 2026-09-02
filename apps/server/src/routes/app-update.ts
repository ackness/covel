import { Hono } from "hono";
import { z } from "zod";
import { outboundFetch } from "@covel/ai-provider";
import { readRuntimeEnv } from "@covel/shared";
import { errorBody } from "../api-error.js";
import { makeDesktopRestTokenGuard } from "./privileged-auth.js";

const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/AcKnEsS/covel/releases/latest";
const RELEASE_TAG_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const releaseTagSchema = z
  .string()
  .regex(RELEASE_TAG_PATTERN)
  .refine((value) => {
    const prerelease = RELEASE_TAG_PATTERN.exec(value)?.[4];
    return !prerelease
      ?.split(".")
      .some((part) => /^\d+$/.test(part) && /^0\d+/.test(part));
  }, "numeric prerelease identifiers must not contain leading zeroes");

const githubReleaseSchema = z
  .object({
    tag_name: releaseTagSchema,
    name: z.string().nullable().optional(),
    published_at: z.iso.datetime(),
    draft: z.boolean(),
    prerelease: z.boolean(),
  })
  .passthrough();

export interface LatestCovelRelease {
  readonly version: string;
  readonly name: string | null;
  readonly publishedAt: string;
}

type ReleaseFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Fetch the latest stable GitHub Release through Covel's configured proxy. */
export async function fetchLatestCovelRelease(
  fetchImpl: ReleaseFetch = outboundFetch,
): Promise<LatestCovelRelease> {
  const response = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Covel-Desktop-Update-Check",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`GitHub release check failed with HTTP ${response.status}`);
  }

  const parsed = githubReleaseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      `GitHub release response is invalid: ${parsed.error.message}`,
    );
  }
  if (parsed.data.draft || parsed.data.prerelease) {
    throw new Error("GitHub latest release was not a stable published release");
  }

  return {
    version: parsed.data.tag_name.replace(/^v/, ""),
    name: parsed.data.name ?? null,
    publishedAt: parsed.data.published_at,
  };
}

export interface AppUpdateRoutesDeps {
  readonly fetchLatestRelease?: () => Promise<LatestCovelRelease>;
}

export function createAppUpdateRoutes(deps: AppUpdateRoutesDeps = {}): Hono {
  const app = new Hono();
  const requireToken = makeDesktopRestTokenGuard();
  const fetchLatestRelease =
    deps.fetchLatestRelease ?? (() => fetchLatestCovelRelease());

  app.get("/api/app-update/latest", requireToken, async (c) => {
    const env = readRuntimeEnv();
    if (!env.desktopRest) {
      return c.json(
        errorBody("App update checks are available only in desktop mode.", {
          code: "app_update_unavailable",
        }),
        404,
      );
    }

    try {
      return c.json(await fetchLatestRelease());
    } catch (error) {
      console.warn("[app-update] GitHub release check failed:", error);
      return c.json(
        errorBody("Could not check the latest Covel release.", {
          code: "app_update_check_failed",
        }),
        502,
      );
    }
  });

  return app;
}
