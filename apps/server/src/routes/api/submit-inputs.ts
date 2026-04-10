/**
 * API Submit Inputs route — handles player interaction responses.
 *
 * Supports multiple interaction types: form, choice, confirmation.
 * When a turn produces pendingInputs, the player responds here. The framework:
 * 1. Saves the raw submission(s) to store
 * 2. Finds the interaction's narrative template from the originating runtime
 * 3. Fills template placeholders with player values (translation to natural language)
 * 4. Appends the filled narrative as a TurnMessage (player-input source)
 *
 * The filled message is pure natural language — no JSON structures.
 * It becomes part of the conversation history, visible to the narrator on the next turn.
 *
 * Template authoring is the plugin's responsibility:
 * - form: {{fieldName}} → player's value
 * - choice: {{selectedId}}, {{selectedLabel}} → player's chosen option
 * - confirmation: {{confirmed}} → "确认" or "取消"
 */

import { Hono } from 'hono';
import type { DataStore } from '@covel/store';

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const submitInputsRoutes = new Hono<Env>();

// ── Types ────────────────────────────────────────────────────────

interface Submission {
  readonly interactionId: string;
  readonly type: 'form' | 'choice' | 'confirmation';
  readonly values: Record<string, unknown>;
}

interface SubmitInputBody {
  readonly turnId: string;
  readonly submissions?: readonly Submission[];
  /** @deprecated Legacy single-form fields. Wrapped into submissions internally. */
  readonly formId?: string;
  readonly values?: Record<string, unknown>;
}

// ── Route ────────────────────────────────────────────────────────

submitInputsRoutes.post('/:id/submit-inputs', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: `Session "${sessionId}" not found` }, 404);
  }

  const body = await c.req.json<SubmitInputBody>();

  if (!body.turnId || typeof body.turnId !== 'string') {
    return c.json({ error: 'turnId (string) is required' }, 400);
  }

  // Normalize: legacy { formId, values } → submissions array
  const validTypes = new Set(['form', 'choice', 'confirmation']);
  const submissions: Submission[] = body.submissions
    ? [...body.submissions]
    : body.formId && body.values
      ? [{ interactionId: body.formId, type: 'form', values: body.values }]
      : [];

  if (submissions.length === 0) {
    return c.json({ error: 'submissions[] or formId+values are required' }, 400);
  }

  // Validate each submission
  for (const sub of submissions) {
    if (!sub.interactionId || typeof sub.interactionId !== 'string') {
      return c.json({ error: 'Each submission requires interactionId (string)' }, 400);
    }
    if (!validTypes.has(sub.type)) {
      return c.json({ error: `Invalid submission type: ${sub.type}. Must be form|choice|confirmation` }, 400);
    }
    if (!sub.values || typeof sub.values !== 'object' || Array.isArray(sub.values)) {
      return c.json({ error: `submission.values must be an object for interactionId: ${sub.interactionId}` }, 400);
    }
  }

  // Load turn messages once for all submissions
  const messages = await store.listTurnMessages(sessionId);
  const results: Array<{ submissionId: string; interactionId: string; filledNarrative: string; accepted: boolean }> = [];

  for (const sub of submissions) {
    // 1. Save raw submission
    const submissionId = crypto.randomUUID();
    await store.savePlayerInput({
      id: submissionId,
      sessionId,
      turnId: body.turnId,
      formId: sub.interactionId,
      values: sub.values,
      createdAt: new Date().toISOString(),
    });

    // 2. Find the interaction's template message
    const templateMessage = findTemplateMessage(messages, body.turnId, sub.interactionId);

    // 3. Fill template → pure natural language narrative
    const filledNarrative = fillTemplate(sub, templateMessage);

    // 4. Append as player-input message
    await store.appendTurnMessage({
      id: crypto.randomUUID(),
      sessionId,
      turnId: body.turnId,
      sourceType: 'player-input',
      role: 'assistant',
      name: templateMessage?.name ? `${templateMessage.name}-result` : 'player-input',
      content: filledNarrative,
      order: (templateMessage?.order ?? 700) + 1,
      createdAt: new Date().toISOString(),
    });

    // 5. Auto-create CharacterRecord when a character-creation form is submitted (idempotent).
    // Detection uses plugin convention: form values include `_createCharacter: true`.
    // Framework NEVER hardcodes specific plugin IDs or interaction ID patterns.
    const isCharCreation = sub.type === 'form' && sub.values._createCharacter === true;
    if (isCharCreation) {
      const charName = (sub.values.characterName as string) ?? (sub.values.name as string) ?? '未命名';
      const now = new Date().toISOString();
      // Reuse existing player character ID to avoid duplicates on resubmission
      const existingChars = await store.listCharacters(sessionId);
      const existingPlayer = existingChars.find((ch) => ch.type === 'player');
      await store.upsertCharacter({
        id: existingPlayer?.id ?? crypto.randomUUID(),
        sessionId,
        name: charName,
        type: 'player',
        description: Object.entries(sub.values)
          .filter(([k]) => k !== 'characterName' && k !== 'name')
          .map(([k, v]) => `${k}: ${String(v)}`)
          .join(', '),
        fields: sub.values,
        version: (existingPlayer?.version ?? 0) + 1,
        createdAt: existingPlayer?.createdAt ?? now,
        updatedAt: now,
      });
    }

    results.push({ submissionId, interactionId: sub.interactionId, filledNarrative, accepted: true });
  }

  // Backward compat response shape for single form
  if (results.length === 1 && body.formId) {
    return c.json({
      submissionId: results[0].submissionId,
      formId: body.formId,
      filledNarrative: results[0].filledNarrative,
      accepted: true,
    });
  }

  return c.json({ results, accepted: true });
});

// ── Helpers ──────────────────────────────────────────────────────

interface MessageLike {
  readonly turnId: string;
  readonly pendingInput?: unknown;
  readonly content: string;
  readonly name?: string;
  readonly order: number;
}

function findTemplateMessage(
  messages: readonly MessageLike[],
  turnId: string,
  interactionId: string,
): MessageLike | undefined {
  return messages.find((m) => {
    if (m.turnId !== turnId || !m.pendingInput) return false;
    const pi = m.pendingInput;

    // New format: pendingInput is array of interactions
    if (Array.isArray(pi)) {
      return (pi as Array<Record<string, unknown>>).some(
        (i) => i.interactionId === interactionId,
      );
    }

    // Legacy format: pendingInput is a single form object
    return (pi as Record<string, unknown>).formId === interactionId;
  });
}

function fillTemplate(sub: Submission, templateMessage: MessageLike | undefined): string {
  if (!templateMessage) {
    return fallbackNarrative(sub);
  }

  // Find the specific interaction's narrativeTemplate (new format)
  let template = templateMessage.content;
  if (Array.isArray(templateMessage.pendingInput)) {
    const interaction = (templateMessage.pendingInput as Array<Record<string, unknown>>).find(
      (i) => i.interactionId === sub.interactionId,
    );
    if (interaction?.narrativeTemplate && typeof interaction.narrativeTemplate === 'string') {
      template = interaction.narrativeTemplate;
    }
  }

  // Build replacement values based on interaction type
  const replacements = buildReplacements(sub);

  // Replace all {{key}} placeholders
  return template.replace(
    /\{\{\s*([^}]+?)\s*\}\}/g,
    (_match, key: string) => {
      const value = replacements[key.trim()];
      return value !== undefined && value !== null ? String(value) : '';
    },
  );
}

function buildReplacements(sub: Submission): Record<string, unknown> {
  switch (sub.type) {
    case 'form':
      // Form: all field values are direct replacements
      return sub.values;

    case 'choice': {
      // Choice: provide selectedId and selectedLabel
      return {
        ...sub.values,
        selectedId: sub.values.selectedId,
        selectedLabel: sub.values.selectedLabel ?? sub.values.selectedId,
      };
    }

    case 'confirmation': {
      // Confirmation: provide confirmed as human-readable text
      const confirmed = sub.values.confirmed;
      return {
        ...sub.values,
        confirmed: confirmed ? '确认' : '取消',
      };
    }
  }
}

function fallbackNarrative(sub: Submission): string {
  switch (sub.type) {
    case 'form': {
      const entries = Object.entries(sub.values)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ');
      return `[玩家输入] ${entries}`;
    }
    case 'choice':
      return `[玩家选择] ${String(sub.values.selectedLabel ?? sub.values.selectedId)}`;
    case 'confirmation':
      return `[玩家${sub.values.confirmed ? '确认' : '取消'}] ${String(sub.values.prompt ?? '')}`;
  }
}
