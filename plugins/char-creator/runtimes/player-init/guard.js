import {
  pickLocaleText as pick,
  makeProposal,
  withPendingProposals,
  wordId,
} from "@covel/plugin-handlers-utils";
import {
  CharacterFieldValidationError,
  mergeSchemaDefaults,
} from "@covel/tools";

/**
 * guard.js — Pre-execution gate for player-init runtime.
 *
 * Three branches:
 *   1. Player already exists → skip LLM; emit preGameDone=true so the
 *      kernel resolves this setup runtime and advances the session phase to
 *      playing when every required setup runtime is done.
 *   2. No player AND player has submitted the char-creation form
 *      → synthesise create-character deterministically from lastFormValues,
 *        skip LLM, emit preGameDone=true. The LLM version of "Step 2" is
 *        flaky on weaker models (e.g. qwen3.5-flash) — they often re-render
 *        the form instead of calling `create-character`. By doing it here
 *        we remove the non-determinism that blocks the whole turn pipeline.
 *   3. No player AND no submission yet → proceed to LLM so it generates
 *      the opening form (Step 1 in PLUGIN.md).
 *
 * @type {import("@covel/plugin-handlers-utils").PluginAgentGuard}
 */
export default async function guard(ctx) {
  const { logger, sessionId, store, locale } = ctx;

  const characters = ctx.world?.characters;
  const player = Array.isArray(characters)
    ? characters.find((c) => c.type === "player")
    : null;
  // Ordering alone does not guarantee the schema provider succeeded. Use the
  // execution-local World Model, which includes same-turn schema proposals,
  // and fail outside the recoverable-error fallback below.
  if (!player && !ctx.world?.characterSchema) {
    throw new Error(
      "Character schema is not ready. Complete world initialization before creating a player.",
    );
  }

  try {
    // ── Branch 1: player already created — skip
    if (player) {
      return {
        skip: true,
        playerExists: true,
        playerId: player.id,
        narrativeOutput: "",
        preGameDone: true,
      };
    }

    // ── Branch 2: player submitted form → create deterministically
    const submission = await latestSubmission(store);
    if (submission) {
      const values =
        submission.values !== null &&
        typeof submission.values === "object" &&
        !Array.isArray(submission.values)
          ? /** @type {Record<string, unknown>} */ (submission.values)
          : {};
      const name = pickName(values);
      if (name) {
        const now = new Date().toISOString();
        // A word id from the name (`char-lin-yao`): models read and write
        // character ids, and a UUID is long and easy to miscopy.
        const id = wordId(
          "char",
          name,
          new Set((characters ?? []).map((character) => character.id)),
        );
        try {
          // Merge declared schema defaults into stored fields so the player
          // record the model reads (get-character / prompt context) matches
          // what the character panel shows (the panel overlays defaults at
          // render time). Schema is discovered by its well-known namespace/key,
          // not by a hardcoded world-data plugin id.
          const schema = ctx.world?.characterSchema ?? null;
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

          await logger?.info("player-init guard created submitted player", {
            playerId: id,
          });
          return withPendingProposals(
            {
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
            },
            [
              makeProposal(ctx, now, "character.upsert", {
                id,
                name,
                type: "player",
                description: character.description,
                fields,
                version: 1,
                createdAt: now,
              }),
            ],
          );
        } catch (err) {
          // A valid UI submission can still violate the world attribute types.
          // Preserve it for correction; never let an LLM silently reinterpret it.
          if (err instanceof CharacterFieldValidationError) {
            err.message +=
              " The original form submission is retained for audit. Start a new character-creation session to submit a corrected form; retrying this accepted submission cannot change its values.";
            throw err;
          }
          await logger?.warn?.(
            "player-init guard: deterministic create-character failed, falling back to LLM",
            { error: err instanceof Error ? err.message : String(err) },
          );
          // Fall through to LLM branch
        }
      }
    }

    // ── Branch 3: nothing submitted yet → let LLM generate the opening form
    return { skip: false };
  } catch (err) {
    if (err instanceof CharacterFieldValidationError) throw err;
    await logger?.warn?.("player-init guard error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { skip: false, error: String(err) };
  }
}

/**
 * Fetch the most recent player_inputs row for this session, or null.
 * @param {import("@covel/plugin-handlers-utils").FunctionStoreView} store
 */
async function latestSubmission(store) {
  try {
    const inputs = await store.listPlayerInputs();
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
  const {
    characterName: _characterName,
    name: _name,
    姓名: _zhName,
    playerName: _playerName,
    ...rest
  } = values;
  return rest;
}
