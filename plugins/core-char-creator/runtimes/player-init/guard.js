/**
 * guard.js — Pre-execution gate for player-init runtime.
 *
 * Skips LLM invocation when the session already has a player character.
 * Without this guard, player-init would fire again on every turn it's
 * scheduled for and risk re-creating the player.
 *
 * Also transitions session phase from `character_creation` → `playing`
 * when it detects the player now exists (post-commit from the previous
 * invocation). This keeps phase management inside the plugin instead of
 * in the server submit-inputs magic path.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function guard(ctx) {
  const { sessionId, store } = ctx;
  const s = /** @type {any} */ (store);

  try {
    const characters = await s.listCharacters(sessionId);
    const player = Array.isArray(characters)
      ? characters.find((c) => c.type === 'player')
      : null;

    console.log(`[player-init/guard] sessionId=${sessionId} characters=${Array.isArray(characters) ? characters.length : 'N/A'} playerFound=${!!player}`);

    if (player) {
      // Player already exists — skip and ensure session is in playing phase
      console.log(`[player-init/guard] SKIP — player already exists id=${player.id} name=${player.name}`);
      try {
        const session = await s.getSession(sessionId);
        if (session && session.phase !== 'playing') {
          await s.updateSession(sessionId, { phase: 'playing' });
          console.log(`[player-init/guard] phase updated: ${session.phase} → playing`);
        }
      } catch {
        // Non-critical: phase transition failure doesn't block skip
      }

      return {
        skip: true,
        playerExists: true,
        playerId: player.id,
        narrativeOutput: '', // no-op, don't add messages
      };
    }

    console.log(`[player-init/guard] PROCEED — no player found, running LLM`);
    return { skip: false };
  } catch (err) {
    console.warn('[core-char-creator/player-init] guard error:', err);
    return { skip: false, error: String(err) };
  }
}
