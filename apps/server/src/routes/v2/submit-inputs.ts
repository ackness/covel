/**
 * V2 Submit Inputs route — handles player form submissions.
 *
 * When a turn produces pendingInputs (e.g., character creation form),
 * the player fills in the form and submits here. The framework:
 * 1. Saves the raw submission to store
 * 2. Finds the narrative template from the originating runtime
 * 3. Fills {{fieldName}} placeholders with player values
 * 4. Appends the filled narrative as a TurnMessage (player-input source)
 *
 * This filled message becomes part of the conversation history,
 * visible to the narrator on the next turn.
 */

import { Hono } from 'hono';
import type { DataStore } from '@covel/store';

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const submitInputsRoutes = new Hono<Env>();

// POST /v2/session/:id/submit-inputs
submitInputsRoutes.post('/:id/submit-inputs', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: `Session "${sessionId}" not found` }, 404);
  }

  const body = await c.req.json<{
    turnId: string;
    formId: string;
    values: Record<string, unknown>;
  }>();

  if (!body.formId || !body.values || !body.turnId) {
    return c.json({ error: 'turnId, formId, and values are required' }, 400);
  }

  // 1. Save raw submission
  const submissionId = crypto.randomUUID();
  await store.savePlayerInput({
    id: submissionId,
    sessionId,
    turnId: body.turnId,
    formId: body.formId,
    values: body.values,
    createdAt: new Date().toISOString(),
  });

  // 2. Find the narrative template from turn messages
  // TODO: Add store.listTurnMessagesByTurn(sessionId, turnId) for efficiency
  const messages = await store.listTurnMessages(sessionId);
  const templateMessage = messages.find(
    (m) =>
      m.turnId === body.turnId &&
      m.pendingInput &&
      (m.pendingInput as Record<string, unknown>).formId === body.formId,
  );

  let filledNarrative = '';

  if (templateMessage) {
    // 3. Fill {{fieldName}} placeholders with player values
    filledNarrative = templateMessage.content.replace(
      /\{\{\s*([^}]+?)\s*\}\}/g,
      (_match, fieldName: string) => {
        const value = body.values[fieldName.trim()];
        return value !== undefined && value !== null ? String(value) : '';
      },
    );
  } else {
    // Fallback: create a summary from the values
    const entries = Object.entries(body.values)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');
    filledNarrative = `[角色信息] ${entries}`;
  }

  // 4. Append filled narrative as a TurnMessage
  await store.appendTurnMessage({
    id: crypto.randomUUID(),
    sessionId,
    turnId: body.turnId,
    sourceType: 'player-input',
    role: 'assistant', // assistant role so narrator sees it as context, not as player's direct message
    name: templateMessage?.name ? `${templateMessage.name}-result` : 'player-input',
    content: filledNarrative,
    order: (templateMessage?.order ?? 700) + 1, // Just after the originating plugin
    createdAt: new Date().toISOString(),
  });

  return c.json({
    submissionId,
    formId: body.formId,
    filledNarrative,
    accepted: true,
  });
});
