import { withPendingProposals } from "@covel/tools";
import { createHash } from "node:crypto";
import {
  GENERATED_NS,
  GENERATE_REQUESTED_TOPIC,
  REGISTRY_KEY,
  SCENES_NS,
  STAGE_KEY,
  STAGE_NS,
  buildStageRecord,
  makeStageProposal,
} from "../../lib/stage-data.js";

const DEFAULT_MAX_GENERATED = 10;

/**
 * Resolve the current scene + time of day from a `scene.set` event and
 * publish `stage/current` for the visual stage. Matches the world scene
 * registry, then scenes already generated this session; unmatched
 * locations are queued for background generation
 * (`scene-stage/background-gen`), gated by `autoGenerateScenes` /
 * `maxGeneratedScenes`.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 */
export default async function handler(ctx) {
  const evt = ctx.triggerEvent;
  const location =
    typeof evt?.data?.location === "string" ? evt.data.location.trim() : "";
  if (!evt || evt.topic !== "scene.set" || !location) {
    return {
      outcome: "success",
      value: { skipped: true, reason: "no usable scene.set payload" },
    };
  }
  const variant = evt.data.timeOfDay === "night" ? "night" : "day";
  const visualHint =
    typeof evt.data.visualHint === "string" ? evt.data.visualHint : undefined;

  const [registry, previous, generatedRows] = ctx.pluginData
    ? await Promise.all([
        ctx.pluginData.get(SCENES_NS, REGISTRY_KEY),
        ctx.pluginData.get(STAGE_NS, STAGE_KEY),
        ctx.pluginData.list
          ? ctx.pluginData.list(GENERATED_NS)
          : Promise.resolve([]),
      ])
    : [null, null, []];

  const scenes = Array.isArray(registry?.scenes) ? registry.scenes : [];
  const worldMatch = matchScene(scenes, location);
  const generatedMatch = worldMatch
    ? null
    : matchGenerated(generatedRows, location);

  const candidate = worldMatch
    ? {
        sceneId: String(worldMatch.sceneId),
        name: typeof worldMatch.name === "string" ? worldMatch.name : location,
        source: "world",
        day: worldMatch.day ?? null,
        night: worldMatch.night ?? null,
      }
    : generatedMatch
      ? {
          sceneId: String(generatedMatch.sceneId),
          name:
            typeof generatedMatch.location === "string"
              ? generatedMatch.location
              : location,
          source: "session",
          day: generatedMatch.day ?? null,
          night: generatedMatch.night ?? null,
          visualHint:
            typeof generatedMatch.visualHint === "string"
              ? generatedMatch.visualHint
              : undefined,
        }
      : buildUnmatchedCandidate(ctx, location, generatedRows);

  const stage = buildStageRecord({
    sceneId: candidate.sceneId,
    name: candidate.name,
    variant,
    source: candidate.source,
    day: candidate.day,
    night: candidate.night,
    turnId: ctx.turnId,
  });

  // A "pending" previous stage is never a no-op: if background-gen failed
  // (no `generated` row written), a re-emitted scene.set is the only signal
  // that can retry generation — swallowing it would wedge the stage on
  // "背景生成中…" forever. Successful double-generation is already prevented
  // by background-gen's cachedRef check.
  const isNoOp =
    previous &&
    typeof previous === "object" &&
    previous.source !== "pending" &&
    previous.sceneId === stage.sceneId &&
    previous.variant === stage.variant;
  if (isNoOp) {
    return {
      outcome: "success",
      value: { skipped: true, reason: "no-op: scene/variant unchanged", stage },
    };
  }

  // Night lazy-gen steady-state gap: a session-generated scene (source
  // "session") may only have its day variant on file (day-first, night
  // lazy per A §4/spec §3). If the requested variant is still missing here,
  // re-request generation for it — same gate as a fresh unmatched location,
  // but the scene keeps its existing sceneId/source (no new "generated" row,
  // background-gen merges into the existing one by sceneId).
  const needsVariantBackfill =
    candidate.source === "session" &&
    candidate[variant] == null &&
    isGenerationGateOpen(ctx, generatedRows);

  // Prefer the current event's hint; fall back to the one stored on the
  // generated row (a night backfill's scene.set usually carries no hint, so
  // this keeps the night art aligned with the day subject).
  const effectiveHint = visualHint ?? candidate.visualHint;
  const proposal = makeStageProposal(ctx, stage);
  // Mixing split: `stage` is the business value, the generate-requested event
  // is a domain effect. The kernel projects effects.events back to the legacy
  // top-level `events` key that turn-event-chain / normalizeOutput read.
  const envelope =
    candidate.source === "pending" || needsVariantBackfill
      ? {
          outcome: "success",
          value: { stage },
          effects: {
            events: [
              {
                topic: GENERATE_REQUESTED_TOPIC,
                data: {
                  sceneId: candidate.sceneId,
                  location,
                  ...(effectiveHint ? { visualHint: effectiveHint } : {}),
                  variant,
                },
              },
            ],
          },
        }
      : { outcome: "success", value: { stage } };

  return withPendingProposals(envelope, [proposal]);
}

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @param {string} location
 * @param {ReadonlyArray<{key: string, value: unknown}>} generatedRows
 */
function buildUnmatchedCandidate(ctx, location, generatedRows) {
  const sceneId = sceneIdForLocation(location);
  const gated = isGenerationGateOpen(ctx, generatedRows);
  return {
    sceneId,
    name: location,
    source: gated ? "pending" : "none",
    day: null,
    night: null,
  };
}

/**
 * Shared auto-generate gate: `autoGenerateScenes` (default true) and the
 * per-session `maxGeneratedScenes` cap. Used both for brand-new unmatched
 * locations and for backfilling a missing variant on an already-generated
 * scene (the latter doesn't consume a new cap slot — background-gen merges
 * into the existing `generated` row by sceneId — but still respects the
 * same on/off switch and cap).
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @param {ReadonlyArray<unknown>} generatedRows
 */
function isGenerationGateOpen(ctx, generatedRows) {
  const autoGenerate = ctx.userSettings?.autoGenerateScenes !== false;
  const maxGenerated = resolveMaxGenerated(
    ctx.userSettings?.maxGeneratedScenes,
  );
  return autoGenerate && generatedRows.length < maxGenerated;
}

/**
 * Deterministic scene id for a location that has no registry entry —
 * `gen-` + first 8 hex chars of sha256(location). Stable across turns so
 * the same unmatched location always maps to the same id (used to key the
 * `generated` index and to dedupe repeated pending/none writes).
 *
 * @param {string} location
 * @returns {string}
 */
function sceneIdForLocation(location) {
  return `gen-${createHash("sha256").update(location, "utf8").digest("hex").slice(0, 8)}`;
}

function resolveMaxGenerated(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0
    ? Math.floor(num)
    : DEFAULT_MAX_GENERATED;
}

function normalizeLocation(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/**
 * Match a location against the world registry: exact name/locationRef
 * equality first, then bidirectional normalized substring.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} scenes
 * @param {string} location
 */
function matchScene(scenes, location) {
  const loc = normalizeLocation(location);
  if (!loc) return null;

  for (const scene of scenes) {
    if (!scene || typeof scene !== "object") continue;
    if (
      normalizeLocation(scene.name) === loc ||
      normalizeLocation(scene.locationRef) === loc
    ) {
      return scene;
    }
  }
  for (const scene of scenes) {
    if (!scene || typeof scene !== "object") continue;
    const keys = [scene.name, scene.locationRef]
      .map(normalizeLocation)
      .filter(Boolean);
    if (keys.some((key) => loc.includes(key) || key.includes(loc))) {
      return scene;
    }
  }
  return null;
}

/**
 * Match a location against scenes generated earlier this session (the
 * `generated` plugin_data namespace), same exact-then-fuzzy strategy as
 * `matchScene`.
 *
 * @param {ReadonlyArray<{key: string, value: unknown}>} rows
 * @param {string} location
 */
function matchGenerated(rows, location) {
  const loc = normalizeLocation(location);
  if (!loc || !Array.isArray(rows)) return null;

  const values = rows
    .map((row) => row?.value)
    .filter((value) => value && typeof value === "object");

  for (const value of values) {
    if (normalizeLocation(value.location) === loc) return value;
  }
  for (const value of values) {
    const key = normalizeLocation(value.location);
    if (key && (loc.includes(key) || key.includes(loc))) return value;
  }
  return null;
}
