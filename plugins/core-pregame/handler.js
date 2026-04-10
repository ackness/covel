/**
 * Pre-Game handler — pure function runtime, no LLM.
 *
 * Initializes the game session: reads world info from store,
 * sets up initial state, and returns a welcome context for
 * downstream plugins (narrator, codex, char-creator).
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function pregameHandler(ctx) {
  const { sessionId, store } = ctx;

  // 1. Read session and world info from store
  let worldName = '未知世界';
  let worldSummary = '';

  if (store && typeof store === 'object') {
    const s = /** @type {any} */ (store);
    try {
      const session = await s.getSession(sessionId);
      if (session?.worldId) {
        const world = await s.getWorld(session.worldId);
        if (world) {
          worldName = world.name ?? worldName;
          worldSummary = world.description ?? world.summary ?? '';
        }
      }
    } catch {
      // Store may not have world data (e.g., MemoryStore without seed)
    }
  }

  // 2. Persist phase transition to store
  if (store && typeof store === 'object') {
    const s = /** @type {any} */ (store);
    try {
      await s.updateSession(sessionId, { phase: 'character_creation' });
    } catch { /* non-critical if store doesn't support updateSession */ }
  }

  // 3. Build welcome notification
  const notifications = [
    {
      level: 'info',
      title: `🌍 欢迎来到${worldName}`,
      message: worldSummary || '你的冒险即将开始...',
    },
  ];

  // 4. Return output — narrativeOutput is picked up by downstream plugins as context
  return {
    narrativeOutput: worldSummary
      ? `【${worldName}】${worldSummary}`
      : `游戏初始化完成，欢迎来到${worldName}。`,
    phase: 'character_creation',
    notifications,
    initialized: true,
  };
}
