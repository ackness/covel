import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";

const TURNS_NAMESPACE = "turns";
const MESSAGE_NAMESPACE = "message";
const DEFAULT_COUNT = 3;
const MAX_COUNT = 6;
const MAX_TEXT_LENGTH = 4_000;
const TURN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  const payload = readPayload(ctx.manualPayload);
  if (payload.action === "createCandidates") {
    return createCandidates(ctx, payload);
  }
  if (payload.action === "acceptCandidate") {
    return acceptCandidate(ctx, payload);
  }
  throw new Error(
    "manualPayload.action must be createCandidates or acceptCandidate",
  );
}

function createCandidates(ctx, payload) {
  const now = new Date().toISOString();
  const targetTurnId = normalizeTurnId(payload.turnId ?? ctx.turnId);
  const baseText =
    normalizeOptionalString(payload.baseText, "baseText") ??
    normalizeFallbackText(ctx.playerMessage);
  const count = normalizeCount(payload.count);
  const variants = normalizeStringArray(payload.candidates, "candidates");
  const candidates = buildCandidates({
    turnId: targetTurnId,
    baseText,
    count,
    variants,
    now,
  });
  const selectedCandidateId =
    normalizeOptionalString(
      payload.selectedCandidateId,
      "selectedCandidateId",
    ) ?? candidates[0]?.id;
  const turnRecord = {
    schemaVersion: 1,
    turnId: targetTurnId,
    baseText,
    candidates,
    selectedCandidateId: selectCandidateId(candidates, selectedCandidateId),
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  const messageState = makeMessageState({
    turnId: targetTurnId,
    status: "ready",
    candidateSet: turnRecord,
    selectedCandidateId: turnRecord.selectedCandidateId,
    acceptedCandidateId: undefined,
    updatedAt: now,
  });

  return withPendingProposals(
    {
      action: "createCandidates",
      turnId: targetTurnId,
      candidateCount: candidates.length,
      selectedCandidateId: turnRecord.selectedCandidateId,
    },
    [
      makePluginDataBatchProposal(ctx, now, [
        { namespace: TURNS_NAMESPACE, key: targetTurnId, value: turnRecord },
        {
          namespace: MESSAGE_NAMESPACE,
          key: targetTurnId,
          value: messageState,
        },
      ]),
    ],
  );
}

async function acceptCandidate(ctx, payload) {
  const now = new Date().toISOString();
  const targetTurnId = normalizeTurnId(payload.turnId ?? ctx.turnId);
  const candidateId = normalizeRequiredString(
    payload.candidateId,
    "candidateId",
  );
  const existingTurnRecord = await readTurnRecord(
    ctx.store,
    ctx.sessionId,
    ctx.pluginId,
    targetTurnId,
  );
  if (!existingTurnRecord) {
    throw new Error("branch-reply turn record was not found");
  }
  const candidateSet = existingTurnRecord;
  const accepted = candidateSet.candidates.find(
    (candidate) => candidate.id === candidateId,
  );
  if (!accepted) {
    throw new Error(
      "manualPayload.candidateId must reference an existing candidate",
    );
  }
  const acceptedText =
    normalizeOptionalString(payload.text, "text") ?? accepted.text;
  const nextTurnRecord = {
    ...candidateSet,
    selectedCandidateId: candidateId,
    acceptedCandidateId: candidateId,
    acceptedText,
    status: "accepted",
    updatedAt: now,
  };
  const messageState = makeMessageState({
    turnId: targetTurnId,
    status: "accepted",
    candidateSet: nextTurnRecord,
    selectedCandidateId: candidateId,
    acceptedCandidateId: candidateId,
    updatedAt: now,
  });

  return withPendingProposals(
    {
      action: "acceptCandidate",
      turnId: targetTurnId,
      acceptedCandidateId: candidateId,
      acceptedText,
    },
    [
      makePluginDataBatchProposal(ctx, now, [
        {
          namespace: TURNS_NAMESPACE,
          key: targetTurnId,
          value: nextTurnRecord,
        },
        {
          namespace: MESSAGE_NAMESPACE,
          key: targetTurnId,
          value: messageState,
        },
      ]),
    ],
  );
}

function readPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manualPayload must be an object");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

function normalizeTurnId(value) {
  const turnId = normalizeRequiredString(value, "turnId");
  if (!TURN_ID_PATTERN.test(turnId)) {
    throw new Error(
      "turnId must be 1-128 characters using letters, digits, underscore, dot, colon, or hyphen",
    );
  }
  return turnId;
}

// Intentionally local — NOT @covel/plugin-handlers-utils' normalizeRequiredString.
// This variant additionally enforces MAX_TEXT_LENGTH and uses a `manualPayload.`
// error prefix; the shared helper has no length cap. (makeProposal IS reused from
// the shared package — see the import at the top.)
function normalizeRequiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`manualPayload.${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new Error(`manualPayload.${field} is too large`);
  }
  return trimmed;
}

function normalizeOptionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  return normalizeRequiredString(value, field);
}

function normalizeFallbackText(value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().slice(0, MAX_TEXT_LENGTH);
  }
  return "Continue from this moment.";
}

function normalizeCount(value) {
  if (value === undefined || value === null) return DEFAULT_COUNT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_COUNT) {
    throw new Error(
      `manualPayload.count must be an integer from 1 to ${MAX_COUNT}`,
    );
  }
  return value;
}

function normalizeStringArray(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`manualPayload.${field} must be an array`);
  }
  return value.map((item, index) =>
    normalizeRequiredString(item, `${field}[${index}]`),
  );
}

function selectCandidateId(candidates, requestedId) {
  if (requestedId === undefined) return candidates[0]?.id;
  if (candidates.some((candidate) => candidate.id === requestedId))
    return requestedId;
  throw new Error(
    "manualPayload.selectedCandidateId must reference an existing candidate",
  );
}

function buildCandidates({ turnId, baseText, count, variants, now }) {
  const sourceTexts = variants?.length
    ? variants.slice(0, MAX_COUNT)
    : deterministicTexts(baseText, count);
  return sourceTexts.slice(0, count).map((text, index) => ({
    id: `${turnId}-candidate-${index + 1}`,
    index,
    text,
    source: variants?.length ? "manual" : "deterministic",
    createdAt: now,
  }));
}

function deterministicTexts(baseText, count) {
  const templates = [
    (text) => text,
    (text) => `${text} I watch for the first honest reaction.`,
    (text) => `${text} Then I wait before choosing my next move.`,
    (text) => `${text} I keep my voice steady and focused.`,
    (text) => `${text} I mark the detail that feels out of place.`,
    (text) => `${text} I leave space for a reply.`,
  ];
  return Array.from({ length: count }, (_, index) =>
    templates[index](baseText),
  );
}

function makeMessageState({
  turnId,
  status,
  candidateSet,
  selectedCandidateId,
  acceptedCandidateId,
  updatedAt,
}) {
  return {
    __turnId: turnId,
    schemaVersion: 1,
    turnId,
    status,
    selectedCandidateId,
    ...(acceptedCandidateId ? { acceptedCandidateId } : {}),
    candidates: candidateSet.candidates,
    candidateCount: candidateSet.candidates.length,
    updatedAt,
  };
}

function makePluginDataBatchProposal(ctx, now, items) {
  return makeProposal(ctx, now, "plugin.data.batch", { items });
}

async function readTurnRecord(store, sessionId, pluginId, turnId) {
  if (!store || typeof store !== "object") return undefined;
  const s = /** @type {any} */ (store);
  if (typeof s.getPluginData !== "function") return undefined;
  const row =
    s.getPluginData.length <= 2
      ? await s.getPluginData(TURNS_NAMESPACE, turnId)
      : await s.getPluginData(sessionId, pluginId, TURNS_NAMESPACE, turnId);
  if (!row || typeof row !== "object") return undefined;
  const value = row.value;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.schemaVersion !== 1) return undefined;
  if (record.turnId !== turnId) return undefined;
  if (!Array.isArray(record.candidates)) return undefined;
  const candidates = record.candidates.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = /** @type {Record<string, unknown>} */ (item);
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const text =
      typeof candidate.text === "string" ? candidate.text.trim() : "";
    if (
      !id ||
      !text ||
      id.length > MAX_TEXT_LENGTH ||
      text.length > MAX_TEXT_LENGTH
    )
      return [];
    return [
      {
        ...candidate,
        id,
        text,
        index: Number.isInteger(candidate.index) ? candidate.index : 0,
        source:
          typeof candidate.source === "string" ? candidate.source : "manual",
        createdAt:
          typeof candidate.createdAt === "string"
            ? candidate.createdAt
            : new Date().toISOString(),
      },
    ];
  });
  if (candidates.length === 0) return undefined;
  return /** @type {any} */ ({ ...record, candidates });
}
