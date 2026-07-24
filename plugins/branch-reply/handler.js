import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";

const TURNS_NAMESPACE = "turns";
const MESSAGE_NAMESPACE = "message";
const DEFAULT_COUNT = 3;
const MAX_COUNT = 6;
const MAX_VARIANTS = 2;
const MAX_TEXT_LENGTH = 4_000;
// Fast text slot for regenerate. Unconfigured slots fall back tag-aware to the
// first text slot, so this never hardcodes a provider — only a preferred speed.
const FAST_TEXT_SLOT = "fast";
const TURN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * branch-reply runtime.
 *
 * Two execution paths, selected by the presence of `ctx.manualPayload`:
 *
 *   - SEED (auto trigger, `manualPayload` absent): runs after the narrative
 *     engines each story turn. Reads the active engine's narrative from the
 *     declared `inputs.narrative` binding (`ctx.inputs.narrative`) and seeds
 *     the message block with that reply as candidate[0]. Idempotent per
 *     turnId; skips empty / system turns and unbound activations. This is what
 *     makes the block surface at all — a `ui.message` block only renders once
 *     its `message` namespace is populated, so a manual-only writer could
 *     never bootstrap itself.
 *
 *   - MANUAL (plugin-rpc, `manualPayload` present): the existing
 *     createCandidates / acceptCandidate actions from the block UI.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  if (ctx.manualPayload === undefined) {
    return seedFromNarrative(ctx);
  }
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

/**
 * Seed candidate[0] from the narrative the active story engine produced this
 * turn. Engine-agnostic: reads the declared `inputs.narrative` binding
 * (`ctx.inputs.narrative`) — an InputSlot carrying the producer's post-`select`
 * `/narrativeOutput` plus provenance — instead of matching a concrete engine
 * id, so it works for `narrator`, `chat-mode-narrator`, or any future story
 * engine.
 */
async function seedFromNarrative(ctx) {
  const now = new Date().toISOString();
  const targetTurnId = normalizeTurnId(ctx.turnId);
  // The `inputs.narrative` binding is the only narrative path: an InputSlot
  // whose `value` is the active engine's post-`select` `/narrativeOutput` and
  // whose `source.runtimeId` names the producing runtime. Absent on manual
  // activation or a binding miss.
  const narrative = narrativeFromInputSlot(ctx.inputs?.narrative);

  // Skip empty / system turns and unbound activations — nothing to seed, so the
  // block stays hidden rather than rendering an empty swipe widget.
  if (!narrative) {
    return { outcome: "skipped", skipReason: "no narrative input bound" };
  }
  const baseText = narrative.text;
  // The runtime that produced the narrative this turn. Stored on the turn
  // record so the prompt-history rewriter (`normalizeAcceptedBranchReply` →
  // `isReplaceableAssistantMessage`) targets the narrator's assistant message,
  // not branch-reply's OWN auto-appended seed message (which also lands in the
  // turn's history with sourceRuntimeId="branch-reply"). Discovered, never
  // hardcoded.
  const narrativeRuntimeId = narrative.runtimeId;

  // Idempotency: never seed a turnId twice. A pre-existing record means either
  // a prior seed or a player regenerate/accept already owns this turn.
  const existing = await readTurnRecord(ctx, targetTurnId);
  if (existing) {
    return {
      outcome: "success",
      value: { action: "seed", turnId: targetTurnId, seeded: false },
    };
  }

  const candidates = toCandidates(
    targetTurnId,
    [baseText],
    () => "original",
    now,
  );
  const turnRecord = makeTurnRecord({
    turnId: targetTurnId,
    baseText,
    candidates,
    selectedCandidateId: candidates[0]?.id,
    status: "ready",
    runtimeId: narrativeRuntimeId,
    now,
  });
  const messageState = makeMessageState({
    turnId: targetTurnId,
    status: "ready",
    candidateSet: turnRecord,
    selectedCandidateId: turnRecord.selectedCandidateId,
    acceptedCandidateId: undefined,
    updatedAt: now,
  });

  // NOTE: as an auto/scheduled system function runtime, branch-reply's return
  // value is also appended to conversation history as an assistant TurnMessage
  // (turn-function-runtime.ts) — same as scene-prompts / guide / codex. This
  // compact `{action:"seed",…}` marker carries no `narrativeOutput`/`content`,
  // so it serialises to JSON and the story prompt filters it via
  // `looksLikeStructuredRuntimeOutput`. The prompt-history rewriter ignores it
  // because the turn record's `runtimeId` points at the narrator, not us.
  return withPendingProposals(
    {
      outcome: "success",
      value: {
        action: "seed",
        turnId: targetTurnId,
        seeded: true,
        candidateCount: candidates.length,
      },
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

async function createCandidates(ctx, payload) {
  const now = new Date().toISOString();
  const targetTurnId = normalizeTurnId(payload.turnId ?? ctx.turnId);
  const baseText =
    normalizeOptionalString(payload.baseText, "baseText") ??
    normalizeFallbackText(ctx.playerMessage);
  const count = normalizeCount(payload.count);
  const explicitVariants = normalizeStringArray(
    payload.candidates,
    "candidates",
  );

  // Carry the seeded narrator runtimeId forward so regenerate keeps targeting
  // the narrator's message (not branch-reply's auto-seed message) when the
  // player later accepts a variant. Read it back from the existing turn record
  // rather than trusting the click payload, which never carries it.
  const existing = await readTurnRecord(ctx, targetTurnId);
  const narrativeRuntimeId =
    typeof existing?.runtimeId === "string" ? existing.runtimeId : undefined;

  // Candidate composition, in priority order:
  //   1. explicit `candidates` payload (programmatic / API) — that array IS the
  //      full candidate list (candidate[0] = candidates[0]), no LLM.
  //   2. LLM regenerate via the fast text slot when a gateway is wired —
  //      candidate[0] is the original (`baseText`), then genuine variants.
  //   3. no gateway — return just the original (NEVER fabricate filler text).
  let texts;
  let sourceFor;
  if (explicitVariants) {
    texts = dedupeTexts(explicitVariants).slice(0, count);
    sourceFor = () => "manual";
  } else {
    const variants = ctx.gateway
      ? await generateVariants(ctx, baseText, count - 1)
      : [];
    texts = dedupeTexts([baseText, ...variants]).slice(0, Math.max(1, count));
    sourceFor = (index) => (index === 0 ? "original" : "regenerated");
  }

  const candidates = toCandidates(targetTurnId, texts, sourceFor, now);
  const selectedCandidateId =
    normalizeOptionalString(
      payload.selectedCandidateId,
      "selectedCandidateId",
    ) ?? candidates[0]?.id;
  const turnRecord = makeTurnRecord({
    turnId: targetTurnId,
    baseText,
    candidates,
    selectedCandidateId: selectCandidateId(candidates, selectedCandidateId),
    status: "ready",
    runtimeId: narrativeRuntimeId,
    now,
  });
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
      outcome: "success",
      value: {
        action: "createCandidates",
        turnId: targetTurnId,
        candidateCount: candidates.length,
        selectedCandidateId: turnRecord.selectedCandidateId,
      },
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
  const existingTurnRecord = await readTurnRecord(ctx, targetTurnId);
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
      outcome: "success",
      value: {
        action: "acceptCandidate",
        turnId: targetTurnId,
        acceptedCandidateId: candidateId,
        acceptedText,
      },
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

/**
 * Generate genuine alternative phrasings of a story beat through the
 * function-runtime gateway. Returns up to `MAX_VARIANTS` rewrites in the same
 * language as the original (driven by `ctx.locale` + the original passage).
 *
 * The gateway is absent in test harnesses / hosts without a slot. In that case
 * — and on any provider error — we return `[]` so the caller falls back to the
 * original text only. We never fabricate near-duplicate filler.
 */
async function generateVariants(ctx, baseText, requested) {
  const wanted = Math.max(0, Math.min(requested, MAX_VARIANTS));
  if (wanted === 0 || !ctx.gateway) return [];

  const localeHint =
    typeof ctx.locale === "string" && ctx.locale.trim()
      ? ` The reader's locale is "${ctx.locale.trim()}".`
      : "";
  const system =
    "You rewrite a single interactive-fiction narrative beat into alternative " +
    "phrasings for a branching-reply UI. Preserve the exact same events, " +
    "characters, facts, and outcome — vary only wording, rhythm, and tone. " +
    "Write every alternative in the SAME language as the original passage." +
    localeHint +
    ` Output exactly ${wanted} alternative${wanted > 1 ? "s" : ""}, each ` +
    "separated by a line containing only three hyphens (---). Do not number " +
    "them and do not add any commentary or preamble.";
  const prompt =
    `Original passage:\n\n${baseText}\n\n` +
    `Produce ${wanted} alternative phrasing${wanted > 1 ? "s" : ""} now.`;

  try {
    const result = await ctx.gateway.generateText({
      presetId: FAST_TEXT_SLOT,
      system,
      prompt,
    });
    return parseVariantText(result?.text, baseText, wanted);
  } catch (err) {
    await ctx.logger?.warn?.("branch-reply regenerate failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Split the model's `---`-separated output into clean variant strings:
 * trim, drop empties / separator-only chunks, drop anything equal to the
 * original, dedupe, and cap to `limit`.
 */
function parseVariantText(text, baseText, limit) {
  if (typeof text !== "string") return [];
  const base = baseText.trim();
  const seen = new Set();
  const variants = [];
  for (const chunk of text.split(/^\s*-{3,}\s*$/m)) {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed === base || seen.has(trimmed)) continue;
    if (trimmed.length > MAX_TEXT_LENGTH) continue;
    seen.add(trimmed);
    variants.push(trimmed);
    if (variants.length >= limit) break;
  }
  return variants;
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

/** Trim, drop empties / over-long / duplicates while preserving order. */
function dedupeTexts(texts) {
  const seen = new Set();
  const out = [];
  for (const text of texts ?? []) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed || seen.has(trimmed) || trimmed.length > MAX_TEXT_LENGTH)
      continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Map ordered candidate texts into candidate records with per-index source. */
function toCandidates(turnId, texts, sourceFor, now) {
  return texts.map((text, index) => ({
    id: `${turnId}-candidate-${index + 1}`,
    index,
    text,
    source: sourceFor(index),
    createdAt: now,
  }));
}

function makeTurnRecord({
  turnId,
  baseText,
  candidates,
  selectedCandidateId,
  status,
  runtimeId,
  now,
}) {
  return {
    schemaVersion: 1,
    turnId,
    baseText,
    candidates,
    selectedCandidateId,
    status,
    // The narrating runtime this turn record projects onto. Consumed by the
    // prompt-history rewriter to target the narrator's message rather than
    // branch-reply's own seed message. Omitted when unknown.
    ...(runtimeId ? { runtimeId } : {}),
    createdAt: now,
    updatedAt: now,
  };
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

/**
 * Read the narrative from the `inputs.narrative` binding (InputSlot,
 * `cardinality: "one"`). `value` is the producer's post-`select`
 * `/narrativeOutput` — a string in the declared contract, normalized
 * defensively in case a producer projects a `{ narrativeOutput }` object.
 * `source.runtimeId` is the producing runtime, returned as
 * `{ text, runtimeId? }` so accept/regenerate keep targeting the narrator's
 * message, not branch-reply's own seed. Returns undefined when the slot is
 * absent or carries no usable text, which makes the seed skip the turn.
 *
 * @param {unknown} slot
 * @returns {{ text: string, runtimeId?: string } | undefined}
 */
function narrativeFromInputSlot(slot) {
  if (!slot || typeof slot !== "object") return undefined;
  const record = /** @type {Record<string, unknown>} */ (slot);
  const text = normalizeNarrativeValue(record.value);
  if (!text) return undefined;
  const source = record.source;
  const runtimeId =
    source &&
    typeof source === "object" &&
    typeof (/** @type {Record<string, unknown>} */ (source).runtimeId) ===
      "string"
      ? /** @type {string} */ (
          /** @type {Record<string, unknown>} */ (source).runtimeId
        )
      : undefined;
  return {
    text: text.slice(0, MAX_TEXT_LENGTH),
    ...(runtimeId ? { runtimeId } : {}),
  };
}

/**
 * Normalize a bound narrative value to trimmed text. The contract projects a
 * string via `select: /narrativeOutput`; tolerate a `{ narrativeOutput }`
 * object too so a producer that binds the whole result still resolves.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeNarrativeValue(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const inner = /** @type {Record<string, unknown>} */ (value)
      .narrativeOutput;
    if (typeof inner === "string") return inner.trim();
  }
  return "";
}

async function readTurnRecord(ctx, turnId) {
  // ctx.pluginData is the one scoped plugin-data path — same shape for
  // trusted and community runtimes, so no store arity sniffing.
  if (!ctx.pluginData) return undefined;
  const value = await ctx.pluginData.get(TURNS_NAMESPACE, turnId);
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
