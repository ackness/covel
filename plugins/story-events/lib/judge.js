import { createHash } from "node:crypto";
import { modelFacingJson } from "@covel/plugin-handlers-utils";
import {
  DEFAULT_MAX_JUDGED,
  JUDGE_CONTRACT,
  JUDGE_RUNTIME_ID,
  JUDGMENTS,
  MAX_JUDGED_CAP,
} from "./constants.js";

const MAX_NARRATIVE_CHARS = 5000;
const MAX_PLAYER_CHARS = 1200;
const MAX_WORLD_IR_CHARS = 4000;
const MAX_DIMENSIONS_CHARS = 3000;
const MAX_DATA_BYTES = 24_000;

function truncate(text, limit) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function formatNarrativeSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return "";
  const lines = [];
  for (const segment of segments) {
    if (!segment || typeof segment.text !== "string" || !segment.text.trim())
      continue;
    const speaker =
      typeof segment.speaker === "string" && segment.speaker.trim()
        ? `[${segment.speaker.trim()}] `
        : "";
    lines.push(`${speaker}${segment.text.trim()}`);
  }
  return truncate(lines.join("\n"), MAX_NARRATIVE_CHARS);
}

function compactWorldIR(worldIR) {
  if (!worldIR || typeof worldIR !== "object") return null;
  const compact = {
    ...(typeof worldIR.summary === "string"
      ? { summary: worldIR.summary }
      : {}),
    ...(Array.isArray(worldIR.entities) && worldIR.entities.length
      ? {
          entities: worldIR.entities.slice(0, 16).map((entity) => ({
            name: entity.name,
            type: entity.type,
            ...(entity.description ? { description: entity.description } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(worldIR.relations) && worldIR.relations.length
      ? {
          relations: worldIR.relations.slice(0, 12).map((rel) => ({
            type: rel.type,
            from: rel.from,
            to: rel.to,
            ...(rel.description ? { description: rel.description } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(worldIR.events) && worldIR.events.length
      ? {
          events: worldIR.events.slice(0, 16).map((ev) => ({
            type: ev.type,
            description: ev.description,
          })),
        }
      : {}),
    ...(Array.isArray(worldIR.statements) && worldIR.statements.length
      ? {
          statements: worldIR.statements.slice(0, 12).map((st) => ({
            type: st.type,
            content: st.content,
          })),
        }
      : {}),
  };
  const projected = modelFacingJson(compact);
  return JSON.stringify(projected).length <= MAX_WORLD_IR_CHARS
    ? projected
    : { summary: truncate(worldIR.summary ?? "", 800) };
}

function compactDimensions(dimensions) {
  if (!dimensions || typeof dimensions !== "object") return {};
  const entries = {};
  for (const [id, entry] of Object.entries(dimensions)) {
    if (entry && typeof entry === "object" && "value" in entry)
      entries[id] = entry.value;
  }
  const projected = modelFacingJson(entries);
  if (JSON.stringify(projected).length <= MAX_DIMENSIONS_CHARS)
    return projected;
  // Keep compact scalar/short entries first to stay under the data budget.
  const trimmed = {};
  let used = 2;
  for (const [id, value] of Object.entries(projected)) {
    const serialized = JSON.stringify(value);
    if (used + serialized.length + id.length + 8 > MAX_DIMENSIONS_CHARS) break;
    trimmed[id] = value;
    used += serialized.length + id.length + 8;
  }
  return trimmed;
}

/**
 * Build deterministic change signals and a compact fingerprint for Layer 3
 * cost-funnel checks (`watch` + no-op skip).
 */
export function buildTurnSignals({
  narrativeSegments,
  playerMessage,
  worldIR,
  dimensions,
  worldTime,
  turn,
}) {
  const narrativeText = formatNarrativeSegments(narrativeSegments);
  const playerText = truncate(playerMessage ?? "", MAX_PLAYER_CHARS);
  const presentNames = new Set();
  for (const segment of narrativeSegments ?? []) {
    if (typeof segment?.speaker === "string" && segment.speaker.trim())
      presentNames.add(segment.speaker.trim().toLowerCase());
  }
  for (const entity of worldIR?.entities ?? []) {
    if (typeof entity?.name === "string" && entity.name.trim())
      presentNames.add(entity.name.trim().toLowerCase());
  }
  const dimensionVersions = {};
  for (const [id, entry] of Object.entries(dimensions ?? {})) {
    if (entry && typeof entry === "object" && Number.isInteger(entry.version))
      dimensionVersions[id] = entry.version;
  }
  const worldIRSummary =
    typeof worldIR?.summary === "string" ? worldIR.summary : "";
  const searchableText = [playerText, narrativeText, worldIRSummary]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        playerText,
        narrativeText,
        worldIRSummary,
        dimensionVersions,
        worldTime: worldTime ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  return {
    turn,
    narrativeText,
    playerText,
    worldIR: compactWorldIR(worldIR),
    dimensions: compactDimensions(dimensions),
    dimensionVersions,
    worldTime: worldTime ?? null,
    presentNames,
    searchableText,
    fingerprint,
  };
}

/**
 * Layer 3 funnel: determine whether a shortlisted semantic leaf should wake
 * the judge sub-agent on this turn.
 */
export function passesWatch(item, signals) {
  const cached = item.cached;
  if (cached && cached.fingerprint === signals.fingerprint) return false;

  const watch = item.watch;
  if (!watch || typeof watch !== "object") return true;

  if (
    Number.isInteger(watch.every) &&
    watch.every > 1 &&
    cached &&
    Number.isInteger(cached.turn) &&
    signals.turn - cached.turn < watch.every
  ) {
    return false;
  }

  if (Array.isArray(watch.characters) && watch.characters.length > 0) {
    const matched = watch.characters.some((name) => {
      const lower = String(name).trim().toLowerCase();
      return (
        lower &&
        (signals.presentNames.has(lower) ||
          signals.searchableText.includes(lower))
      );
    });
    if (!matched) return false;
  }

  if (Array.isArray(watch.keywords) && watch.keywords.length > 0) {
    const matched = watch.keywords.some((keyword) => {
      const lower = String(keyword).trim().toLowerCase();
      return lower && signals.searchableText.includes(lower);
    });
    if (!matched) return false;
  }

  if (Array.isArray(watch.dimensions) && watch.dimensions.length > 0) {
    if (cached?.dimensionVersions) {
      const changed = watch.dimensions.some(
        (dimId) =>
          signals.dimensionVersions[dimId] !== cached.dimensionVersions[dimId],
      );
      if (!changed) return false;
    }
  }

  return true;
}

export function resolveMaxJudged(userSettings) {
  const configured = Number(userSettings?.maxJudgedPerTurn);
  if (!Number.isInteger(configured) || configured < 1)
    return DEFAULT_MAX_JUDGED;
  return Math.min(configured, MAX_JUDGED_CAP);
}

/**
 * Build a strictly spoiler-free sub-agent request containing ONLY condition
 * questions and story facts — never hidden payloads, hidden options, or
 * hidden rewards.
 */
export function buildJudgeRequest({ candidates, activeOptions, signals }) {
  const conditions = candidates.map((item) => ({
    key: item.key,
    question: item.question,
    scope: item.scope,
  }));
  const publicOptions = (activeOptions ?? []).map((opt) => ({
    id: opt.id,
    text: opt.text,
  }));

  let data = {
    turn: signals.turn,
    ...(signals.playerText ? { playerMessage: signals.playerText } : {}),
    ...(signals.narrativeText ? { narrative: signals.narrativeText } : {}),
    ...(signals.worldIR ? { worldIR: signals.worldIR } : {}),
    ...(signals.worldTime ? { worldTime: signals.worldTime } : {}),
    ...(Object.keys(signals.dimensions).length
      ? { dimensions: signals.dimensions }
      : {}),
    conditions,
    ...(publicOptions.length ? { activeOptions: publicOptions } : {}),
  };

  // Stay comfortably within the 32 KiB sub-agent `data` cap.
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_DATA_BYTES) {
    data = {
      turn: signals.turn,
      ...(signals.playerText ? { playerMessage: signals.playerText } : {}),
      ...(signals.narrativeText
        ? { narrative: truncate(signals.narrativeText, 2500) }
        : {}),
      ...(signals.worldIR?.summary
        ? { worldIR: { summary: truncate(signals.worldIR.summary, 600) } }
        : {}),
      conditions,
      ...(publicOptions.length ? { activeOptions: publicOptions } : {}),
    };
  }

  const brief =
    "Evaluate each condition in `conditions` strictly from the supplied story evidence" +
    (publicOptions.length
      ? ", and check whether the player's action clearly carried out one of `activeOptions`."
      : ".") +
    " Return structured verdicts via `submit-output`.";

  return { brief, data };
}

/**
 * Run the concealed judge sub-agent at most once per turn. Prefers a custom
 * `story-event.judge@1` provider when unambiguous, otherwise falls back to
 * this plugin's bundled `story-events/judge` runtime.
 */
export async function runSemanticJudge(
  ctx,
  { candidates, activeOptions = [], signals, maxJudged = DEFAULT_MAX_JUDGED },
) {
  const shortlisted = candidates.slice(0, maxJudged);
  if (shortlisted.length === 0 && activeOptions.length === 0) {
    return {
      verdicts: new Map(),
      matchedOptionId: null,
      called: false,
      failed: false,
      diagnostics: [],
    };
  }
  if (!ctx.agents?.run) {
    return {
      verdicts: new Map(),
      matchedOptionId: null,
      called: false,
      failed: true,
      diagnostics: ["semantic judge runtime is unavailable"],
    };
  }

  const { brief, data } = buildJudgeRequest({
    candidates: shortlisted,
    activeOptions,
    signals,
  });

  // Allow a community plugin to replace `story-event.judge@1`, while falling
  // back cleanly to our own runtime when multiple providers coexist.
  let response = await ctx.agents.run({
    target: { contract: JUDGE_CONTRACT },
    brief,
    data,
  });
  if (
    !response?.ok &&
    (response?.error?.code === "ambiguous" ||
      response?.error?.code === "not-found")
  ) {
    response = await ctx.agents.run({
      target: { runtimeId: JUDGE_RUNTIME_ID },
      brief,
      data,
    });
  }

  if (!response?.ok) {
    return {
      verdicts: new Map(),
      matchedOptionId: null,
      called: true,
      failed: true,
      diagnostics: [
        `semantic judge failed: ${response?.error?.code ?? "unknown"}`,
      ],
    };
  }

  const allowedKeys = new Set(shortlisted.map((item) => item.key));
  const allowedOptions = new Set(activeOptions.map((item) => item.id));
  const verdicts = new Map();
  const output = response.output ?? {};
  for (const row of Array.isArray(output.verdicts) ? output.verdicts : []) {
    if (!row || typeof row.key !== "string" || !allowedKeys.has(row.key))
      continue;
    const confidence = row.confidence;
    // Conservative rule: only high/medium confidence triggers; low stays unmet.
    const met =
      row.met === true && (confidence === "high" || confidence === "medium");
    verdicts.set(row.key, {
      key: row.key,
      met,
      confidence:
        confidence === "high" || confidence === "medium" || confidence === "low"
          ? confidence
          : "low",
      ...(typeof row.evidence === "string" && row.evidence.trim()
        ? { evidence: row.evidence.trim().slice(0, 240) }
        : {}),
    });
  }

  const matchedOptionId =
    typeof output.matchedOptionId === "string" &&
    allowedOptions.has(output.matchedOptionId)
      ? output.matchedOptionId
      : null;

  return {
    verdicts,
    matchedOptionId,
    called: true,
    failed: false,
    diagnostics: [],
  };
}

/** Persist non-outcome judge verdicts into `_hidden.judgments` and the in-memory cache. */
export async function persistJudgeVerdicts(
  ctx,
  { candidates, verdicts, judgments, signals, turn, sourceTurnId, phase },
) {
  for (const candidate of candidates) {
    if (candidate.key.startsWith("outcome:")) continue;
    const verdict = verdicts.get(candidate.key);
    if (!verdict) continue;
    const stored = {
      key: candidate.key,
      met: verdict.met,
      confidence: verdict.confidence,
      sticky: candidate.sticky,
      ...(phase ? { phase } : {}),
      turn,
      turnId: ctx.turnId,
      sourceTurnId,
      fingerprint: signals.fingerprint,
      dimensionVersions: signals.dimensionVersions,
    };
    judgments[candidate.key] = stored;
    await ctx.pluginData.set(JUDGMENTS, candidate.key, stored);
  }
}
