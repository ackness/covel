import { pickLocaleText as pick } from "@covel/plugin-handlers-utils";
import { mergeSchemaDefaults, mirrorCharacterToPluginData } from "@covel/tools";

const CHARACTER_PLUGIN_ID = "char-creator";

/**
 * guard.js — Pre-execution gate for player-init runtime.
 *
 * Three branches:
 *   1. Player already exists → skip LLM; emit preGameDone=true so the
 *      kernel advances turnCount from 0 to 1.
 *   2. No player AND player has submitted the char-creation form
 *      → synthesise create-character deterministically from lastFormValues,
 *        skip LLM, emit preGameDone=true. The LLM version of "Step 2" is
 *        flaky on weaker models (e.g. qwen3.5-flash) — they often re-render
 *        the form instead of calling `create-character`. By doing it here
 *        we remove the non-determinism that blocks the whole turn pipeline.
 *   3. No player AND no submission yet → proceed to LLM so it generates
 *      the opening form (Step 1 in PLUGIN.md).
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function guard(ctx) {
  const { logger, sessionId, store, locale } = ctx;
  const s = /** @type {any} */ (store);

  try {
    const characters = await s.listCharacters(sessionId);
    const player = Array.isArray(characters)
      ? characters.find((c) => c.type === "player")
      : null;

    await logger?.debug("player-init guard inspected session", {
      characterCount: Array.isArray(characters) ? characters.length : "N/A",
      playerFound: Boolean(player),
    });

    // ── Branch 1: player already created — skip
    if (player) {
      await mirrorPlayer(s, sessionId, player);
      await logger?.debug("player-init guard skipped existing player", {
        playerId: player.id,
      });
      return {
        skip: true,
        playerExists: true,
        playerId: player.id,
        narrativeOutput: "",
        preGameDone: true,
      };
    }

    // ── Branch 2: player submitted form → create deterministically
    const submission = await latestSubmission(s, sessionId);
    if (submission) {
      const values = /** @type {Record<string, unknown>} */ (
        submission.values ?? {}
      );
      const name = pickName(values);
      if (name) {
        const now = new Date().toISOString();
        const id = `char-${crypto.randomUUID()}`;
        try {
          // Merge declared schema defaults into stored fields so the player
          // record the model reads (get-character / prompt context) matches
          // what the character panel shows (the panel overlays defaults at
          // render time). Schema is discovered by its well-known namespace/key,
          // not by a hardcoded world-data plugin id.
          const schema = await loadCharacterAttributesSchema(s, sessionId);
          const fields = mergeSchemaDefaults(stripNameKeys(values), schema);
          const character = {
            id,
            sessionId,
            name,
            type: "player",
            description: pickDescription(values),
            fields,
            version: 1,
            createdAt: now,
            updatedAt: now,
          };
          await s.upsertCharacter(character);
          await mirrorPlayer(s, sessionId, character);
          await logger?.info("player-init guard created submitted player", {
            playerId: id,
          });
          return {
            skip: true,
            playerExists: true,
            playerId: id,
            playerName: name,
            narrativeOutput: pick(
              locale,
              `[系统] 已创建角色 ${name}，冒险即将开始……`,
              `[System] Character ${name} created — your adventure is about to begin…`,
            ),
            preGameDone: true,
          };
        } catch (err) {
          console.warn(
            "[player-init/guard] deterministic create-character failed, falling back to LLM:",
            err,
          );
          // Fall through to LLM branch
        }
      }
    }

    // ── Branch 3: nothing submitted yet → let LLM generate the opening form
    await logger?.debug("player-init guard proceeding to form generation");
    return { skip: false };
  } catch (err) {
    console.warn("[char-creator/player-init] guard error:", err);
    return { skip: false, error: String(err) };
  }
}

/**
 * Discover the session's character-attribute schema by its well-known
 * `(namespace='schema', key='character-attributes')` location, across all
 * pluginIds — so char-creator never hardcodes the world-data provider's id
 * (framework/plugin isolation). Returns null when unavailable.
 * @param {any} store
 * @param {string} sessionId
 * @returns {Promise<import('@covel/shared').CharacterAttributeSchema | null>}
 */
async function loadCharacterAttributesSchema(store, sessionId) {
  if (typeof store.listPluginDataSessionScope !== "function") return null;
  try {
    const rows = await store.listPluginDataSessionScope(sessionId);
    const row = Array.isArray(rows)
      ? rows.find(
          (r) => r.namespace === "schema" && r.key === "character-attributes",
        )
      : null;
    const value = row?.value;
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray(/** @type {any} */ (value).attributes)
    ) {
      return null;
    }
    return /** @type {any} */ (value);
  } catch {
    return null;
  }
}

/**
 * Fetch the most recent player_inputs row for this session, or null.
 * @param {any} store
 * @param {string} sessionId
 */
async function latestSubmission(store, sessionId) {
  if (typeof store.listPlayerInputs !== "function") return null;
  try {
    const inputs = await store.listPlayerInputs(sessionId);
    if (!Array.isArray(inputs) || inputs.length === 0) return null;
    return inputs[inputs.length - 1];
  } catch {
    return null;
  }
}

/**
 * Pick the character display name from submitted form values. Tries common
 * keys the LLM-generated forms tend to use, in priority order.
 * @param {Record<string, unknown>} values
 */
function pickName(values) {
  const candidates = ["characterName", "name", "姓名", "playerName"];
  for (const key of candidates) {
    const v = values[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Build a short descriptive blurb from submission values — `background` /
 * `bio` if present, otherwise joining a handful of scalar fields.
 * @param {Record<string, unknown>} values
 */
function pickDescription(values) {
  const direct = values.background ?? values.bio ?? values.description;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const parts = [];
  for (const [key, val] of Object.entries(values)) {
    if (key === "characterName" || key === "name") continue;
    if (typeof val === "string" && val.trim()) {
      parts.push(`${key}: ${val.trim()}`);
    }
    if (parts.length >= 3) break;
  }
  return parts.length > 0 ? parts.join("；") : undefined;
}

/**
 * Remove name-like keys from the fields payload so `name` isn't duplicated
 * both on the CharacterRecord and inside fields.
 * @param {Record<string, unknown>} values
 */
function stripNameKeys(values) {
  const { characterName, name, 姓名, playerName, ...rest } =
    /** @type {any} */ (values);
  return rest;
}

/**
 * Mirror the player into plugin_data so the character panel can read it.
 * @param {any} store
 * @param {string} sessionId
 * @param {{
 *   id: string;
 *   name: string;
 *   type: string;
 *   description?: string;
 *   fields?: unknown;
 *   version: number;
 *   createdAt: string;
 *   updatedAt: string;
 * }} character
 */
async function mirrorPlayer(store, sessionId, character) {
  await mirrorCharacterToPluginData(store, sessionId, CHARACTER_PLUGIN_ID, {
    id: character.id,
    name: character.name,
    type: character.type,
    description: character.description,
    fields: character.fields,
    version: character.version,
    createdAt: character.createdAt,
    updatedAt: character.updatedAt,
  });
}
