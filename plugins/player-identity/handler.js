import {
  assertEntityEnvelope,
  compactRecord,
  makeProposal,
  normalizeRequiredString,
  optionalString,
  readManualEntity,
  splitList,
} from "@covel/plugin-handlers-utils";
import { playerIdentityToCharacterUpsert } from "@covel/shared";
import { shortId, withPendingProposals } from "@covel/tools";

const PROFILE_NAMESPACE = "profiles";
const BINDING_NAMESPACE = "session-binding";
const CURRENT_BINDING_KEY = "current";
const DEFAULT_MIRROR_PLUGIN_ID = "player-identity";
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  const payload = ctx.manualPayload ?? {};
  const profile = normalizeProfile(
    readManualEntity(payload, "profile", (form) =>
      profileFromForm(form, ctx.sessionId),
    ),
  );
  const shouldActivate = payload.activate !== false;
  const shouldBindToPlayer = payload.bindToPlayer !== false;
  const now = new Date().toISOString();
  const existingPlayer = shouldBindToPlayer
    ? await findExistingPlayer(ctx.store, ctx.sessionId)
    : undefined;
  const characterId =
    existingPlayer?.id ?? playerCharacterIdForProfile(profile.id);

  const proposals = [
    makeProposal(ctx, now, "plugin.data", {
      namespace: PROFILE_NAMESPACE,
      key: profile.id,
      value: {
        profile,
        updatedAt: now,
        // Mirror the active/bound state INTO the profiles namespace so the
        // single-namespace panel can mark which voice is currently driving the
        // model (the binding itself lives in BINDING_NAMESPACE, which the panel
        // can't read). Exactly one profile carries active:true at a time.
        active: shouldActivate,
        ...(shouldBindToPlayer ? { boundCharacterId: characterId } : {}),
      },
    }),
  ];

  if (shouldActivate) {
    // Clear active on every other saved profile so the panel shows a single
    // active voice. Best-effort: skips silently if the store can't list.
    for (const other of await listOtherProfiles(ctx, profile.id)) {
      proposals.push(
        makeProposal(ctx, now, "plugin.data", {
          namespace: PROFILE_NAMESPACE,
          key: other.key,
          value: { ...other.value, active: false },
        }),
      );
    }
    proposals.push(
      makeProposal(ctx, now, "plugin.data", {
        namespace: BINDING_NAMESPACE,
        key: CURRENT_BINDING_KEY,
        value: {
          profileId: profile.id,
          ...(shouldBindToPlayer ? { characterId } : {}),
          updatedAt: now,
        },
      }),
    );
  }

  if (shouldBindToPlayer) {
    proposals.push(
      makeProposal(
        ctx,
        now,
        "character.upsert",
        playerIdentityToCharacterUpsert(profile, {
          existingPlayer: existingPlayer ?? {
            id: characterId,
            name: profile.name,
          },
          now,
          mirrorPluginId: DEFAULT_MIRROR_PLUGIN_ID,
        }),
      ),
    );
  }

  return withPendingProposals(
    {
      saved: true,
      profileId: profile.id,
      activated: shouldActivate,
      ...(shouldBindToPlayer ? { characterId } : {}),
    },
    proposals,
  );
}

function playerCharacterIdForProfile(profileId) {
  return profileId.startsWith("player-") ? profileId : `player-${profileId}`;
}

/**
 * List saved profile rows other than `activeId`, so activation can clear their
 * `active` flag. Best-effort — returns [] when the store can't list.
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @param {string} activeId
 * @returns {Promise<Array<{ key: string; value: Record<string, unknown> }>>}
 */
async function listOtherProfiles(ctx, activeId) {
  // ctx.pluginData is the one scoped plugin-data path (works identically for
  // trusted and community runtimes) — no store-shape fallback needed.
  if (!ctx.pluginData) return [];
  try {
    const rows = await ctx.pluginData.list(PROFILE_NAMESPACE);
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(
        (r) =>
          r &&
          r.key !== activeId &&
          r.value &&
          typeof r.value === "object" &&
          r.value.active === true,
      )
      .map((r) => ({ key: String(r.key), value: r.value }));
  } catch {
    return [];
  }
}

/**
 * @param {Record<string, unknown>} form
 * @param {string} sessionId
 */
function profileFromForm(form, sessionId) {
  const fields = compactRecord({
    origin: optionalString(form.origin),
    className: optionalString(form.className),
    club: optionalString(form.club),
  });
  const name = normalizeRequiredString(form.name, "profile.name");
  const explicitId = optionalString(form.id);
  return {
    schemaVersion: 1,
    id: explicitId ?? shortId("player", name, sessionId),
    name,
    ...(optionalString(form.description)
      ? { description: optionalString(form.description) }
      : {}),
    ...(optionalString(form.voice)
      ? { voice: optionalString(form.voice) }
      : {}),
    ...(splitList(form.goalsText).length > 0
      ? { goals: splitList(form.goalsText) }
      : {}),
    ...(splitList(form.boundariesText).length > 0
      ? { boundaries: splitList(form.boundariesText) }
      : {}),
    ...(optionalString(form.relationshipTone)
      ? { relationshipTone: optionalString(form.relationshipTone) }
      : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

/**
 * @param {unknown} value
 */
function normalizeProfile(value) {
  return assertEntityEnvelope(value, {
    entity: "profile",
    idPattern: PROFILE_ID_PATTERN,
    idError:
      "profile.id must be 1-128 characters using letters, digits, underscore, or hyphen",
    build: (base) => ({
      ...base,
      name: normalizeRequiredString(base.name, "profile.name"),
    }),
  });
}

async function findExistingPlayer(store, sessionId) {
  if (!store || typeof store !== "object") return undefined;
  const s = /** @type {any} */ (store);
  // Capability check only — characters live outside plugin-data, so this
  // needs the full store. Passing sessionId to a zero-arg test double is
  // harmless, so no arity sniffing.
  if (typeof s.listCharacters !== "function") return undefined;
  const rows = await s.listCharacters(sessionId);
  if (!Array.isArray(rows)) return undefined;
  const player = rows.find(
    (row) => row && typeof row === "object" && row.type === "player",
  );
  if (!player) return undefined;
  return {
    id: String(player.id),
    name: String(player.name),
    type: typeof player.type === "string" ? player.type : "player",
    description:
      typeof player.description === "string" ? player.description : undefined,
    fields: player.fields,
    version: typeof player.version === "number" ? player.version : 1,
    createdAt:
      typeof player.createdAt === "string" ? player.createdAt : undefined,
  };
}
