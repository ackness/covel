import {
  translate,
  makeProposal,
  withPendingProposals,
  wordId,
} from "@covel/plugin-handlers-utils";
import {
  CharacterFieldValidationError,
  mergeSchemaDefaults,
} from "@covel/plugin-handlers-utils";

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
 *   3. No player AND no usable submission → proceed to LLM so it generates
 *      the opening form (Step 1 in PLUGIN.md). A submission the world no
 *      longer accepts lands here too: the form tool offers the form again
 *      with the earlier answers filled in, so the player is never left with
 *      an accepted form that cannot become a character.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginAgentGuard}
 */
export default async function guard(ctx) {
  const { logger, store } = ctx;

  const characters = ctx.world?.characters;
  const player = Array.isArray(characters)
    ? characters.find((c) => c.type === "player")
    : null;
  const schema = ctx.world?.characterSchema ?? null;
  // Ordering alone does not guarantee the schema provider succeeded. Use the
  // execution-local World Model, which includes same-turn schema proposals,
  // and fail outside the recoverable-error fallback below. Once the player
  // has skipped the failed step no schema will arrive: go on without one.
  if (!player && !schema && !(await schemaStepSkipped(ctx))) {
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
      // Merge declared schema defaults into stored fields so the player
      // record the model reads (get-character / prompt context) matches
      // what the character panel shows (the panel overlays defaults at
      // render time).
      const sheet = name
        ? characterFields(stripNameKeys(values), schema)
        : null;
      if (sheet?.refused) {
        // The form was valid when it was shown; the world's attribute types
        // changed since. Never let an LLM reinterpret the values: offer the
        // form again and let the player answer under the current types.
        await logger?.warn?.(
          "player-init guard: the world no longer accepts the submitted form, offering it again",
          { fields: sheet.refused },
        );
      } else if (name && sheet) {
        if (sheet.droppedDefaults.length)
          await logger?.warn?.(
            "player-init guard: left out attribute defaults that do not match their own type",
            { attributes: sheet.droppedDefaults },
          );
        const now = new Date().toISOString();
        // A word id from the name (`char-lin-yao`): models read and write
        // character ids, and a UUID is long and easy to miscopy.
        const id = wordId(
          "char",
          name,
          new Set((characters ?? []).map((character) => character.id)),
        );
        const description = pickDescription(values);
        await logger?.info("player-init guard created submitted player", {
          playerId: id,
        });
        return withPendingProposals(
          {
            skip: true,
            playerExists: true,
            playerId: id,
            playerName: name,
            narrativeOutput: translate(
              ctx,
              "[System] Character {name} created — your adventure is about to begin…",
              { name },
            ),
            preGameDone: true,
          },
          [
            makeProposal(ctx, now, "character.upsert", {
              id,
              name,
              type: "player",
              description,
              fields: sheet.fields,
              version: 1,
              createdAt: now,
            }),
          ],
        );
      }
    }

    // ── Branch 3: nothing usable submitted → let LLM generate the form
    return { skip: false };
  } catch (err) {
    await logger?.warn?.("player-init guard error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { skip: false, error: String(err) };
  }
}

/**
 * The stored fields for a submission, or the submitted keys the world's
 * attribute types refuse. A default that fails its own attribute type is the
 * world's fault, not the player's: it is left out instead of blocking setup.
 * @param {Record<string, unknown>} submitted
 * @param {import("@covel/plugin-handlers-utils").CharacterAttributeSchema | null} schema
 * @returns {{ fields: Record<string, unknown>, droppedDefaults: string[], refused?: undefined } | { refused: string[] }}
 */
function characterFields(submitted, schema) {
  try {
    return {
      fields: mergeSchemaDefaults(submitted, schema),
      droppedDefaults: [],
    };
  } catch (err) {
    if (!(err instanceof CharacterFieldValidationError) || !schema) throw err;
    const failed = new Set(
      err.issues.map((issue) => issue.path.split(".")[0] ?? issue.path),
    );
    const refused = [...failed].filter((key) => Object.hasOwn(submitted, key));
    if (refused.length) return { refused };
    return {
      fields: mergeSchemaDefaults(submitted, {
        ...schema,
        attributes: schema.attributes.filter(
          (attribute) => !failed.has(attribute.id),
        ),
      }),
      droppedDefaults: [...failed],
    };
  }
}

/**
 * True when the player skipped a failed setup step and nothing else is still
 * failing: the schema this runtime waits for will not be produced.
 * @param {Parameters<import("@covel/plugin-handlers-utils").PluginAgentGuard>[0]} ctx
 */
async function schemaStepSkipped(ctx) {
  try {
    const session =
      /** @type {{ setupRuntimes?: Record<string, { state?: string, resolution?: string, lastError?: string }> } | null} */ (
        await ctx.store.getSession()
      );
    const states = Object.entries(session?.setupRuntimes ?? {}).filter(
      ([runtimeId]) => runtimeId !== ctx.runtimeId,
    );
    return (
      states.some(
        ([, state]) => state?.state === "done" && state.resolution === "waived",
      ) &&
      states.every(
        ([, state]) =>
          state?.state === "done" ||
          (state?.state === "pending" && !state.lastError),
      )
    );
  } catch {
    return false;
  }
}

const CREATION_FORM_ID = "char-creation";

/**
 * Fetch the most recent character-creation form submission, or null.
 * @param {import("@covel/plugin-handlers-utils").FunctionStoreView} store
 */
async function latestSubmission(store) {
  try {
    const inputs = await store.listPlayerInputs();
    if (!Array.isArray(inputs)) return null;
    // Other plugins' forms land in the same list; only this plugin's own form
    // (create-character-form sets this id) is a character submission.
    for (let i = inputs.length - 1; i >= 0; i -= 1) {
      if (inputs[i].formId === CREATION_FORM_ID) return inputs[i];
    }
    return null;
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
  return parts.length > 0 ? parts.join("; ") : undefined;
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
