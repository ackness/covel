# Debug Trace Expansion — Design

**Date:** 2026-04-22
**Status:** Draft — pending implementation plan
**Owner:** framework / runtime
**Related:** `packages/runtime/src/{tool-executor,llm-adapter,turn-executor,session-kernel,hooks/pipeline}.ts`, `apps/server/src/routes/api/{actions,traces}.ts`, `apps/web/src/routes/debug.tsx`

## Problem

The `/debug` page cannot show tool calls, LLM prompts/responses, narrative content, UI blocks, state patches, or hook activity. The frontend `debug.tsx` already has rich renderers for every category (`tool.calling` / `tool.completed` / `llm.calling` / `llm.responded` / `message.delta` / `message.completed` / `block.emitted` / `state.patch.applied`), but the backend never emits those events into `trace_events`.

**Evidence from `mistport-6d37b552` session** (live data, 46 events):

```
 15  runtime.completed
 14  runtime.started
 11  proposal.committed
  3  turn.started
  3  turn.completed
```

Zero `tool.*`, zero `llm.*`, zero `message.*`, zero `block.*`, zero `state.*`, zero `hook.*`.

The `tool_calls` table _does_ have data (`ToolExecutor.recordCall` writes it), but no API route exposes it, so it is invisible to debug tooling.

## Goal

Capture runtime internals end-to-end into `trace_events` and push them over the existing `/actions` SSE channel, so that:

- Refreshing `/debug` on any session shows the full tool / LLM / message / block / state / hook trail.
- The session page's execution timeline lights up in real time for the same events.
- Plugin authors and operators can diagnose turn failures without running the process locally.

## Non-goals

- Back-filling historical sessions. Events only start being captured for new turns after this change ships.
- Replacing `tool_calls` / `interaction_records` tables. They still exist for their own purposes (analytics, approval history).
- Adding a separate observability exporter (Langfuse etc.). That already exists as `TraceExporter` and reads from `trace_events`; this change feeds it more data automatically.

## Event Inventory

11 new event types persisted to `trace_events` and broadcast via SSE.

| Category | `type`                | Emit location                                                                                                        | Notes                                                                                     |
| -------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| tool     | `tool.calling`        | `ToolExecutor.execute` — after args parsed, before execute                                                           | Includes `source` / `approvalStatus`                                                      |
| tool     | `tool.completed`      | `ToolExecutor.execute` — success branch                                                                              | Includes both `result` (LLM-facing) and `parsedResult` (full object)                      |
| tool     | `tool.failed`         | `ToolExecutor.execute` — all error branches (NOT_FOUND / DENIED / INVALID_ARGS / VALIDATION_ERROR / EXECUTION_ERROR) | One event per failure, carries structured `code`                                          |
| llm      | `llm.calling`         | `llm-adapter.generate` / `gateway-llm-adapter.generate` entry                                                        | Carries full `messages`, `tools`, slot/model                                              |
| llm      | `llm.responded`       | Same — after stream close + toolCall parse                                                                           | Carries `text`, `toolCalls`, `usage`, `finishReason`                                      |
| message  | `message.completed`   | `turn-executor.ts` — runtime finish, after deltas merged                                                             | **Deltas are not persisted individually** — only the final concatenated content is stored |
| block    | `block.emitted`       | `session-kernel.processRuntimeResult` — after each `ui.render` proposal commits                                      | Payload carries full block                                                                |
| state    | `state.patch.applied` | Same — after each `state.patch` proposal commits                                                                     | Payload carries `packageName` / `summary` / `ops`                                         |
| hook     | `hook.fired`          | `hooks/pipeline.ts` — before every hook invocation                                                                   | One event per hook call across all six lifecycle events                                   |
| hook     | `hook.rewrote`        | Same — when hook returns modified proposal/tool input                                                                | Optional `diff` field if hook provides one                                                |
| hook     | `hook.aborted`        | **Already exists** in `session-kernel.ts` — keep, align field names to new schema                                    | —                                                                                         |

`runtime.progress` envelope is **not** used. Events are stored flat; frontend already supports both readings (outer `type` or inner `payload.type`) so flat is simpler.

### Delta strategy (intentional asymmetry)

| Channel                                    | `message.delta` | `message.completed` |
| ------------------------------------------ | :-------------: | :-----------------: |
| SSE (realtime, existing `narrative.delta`) | yes (per-token) |   yes (on finish)   |
| `trace_events` (persisted)                 |     **no**      |         yes         |

The realtime typewriter effect in the session UI still works; `trace_events` sees one compact record per runtime output instead of thousands of per-token rows.

### Payload schemas

All events include common fields `{ runtimeId, pluginId }` when scoped to a runtime, plus the `TraceEvent` envelope injects `seq` / `requestId` / `flowId` / `timestamp`.

```ts
// tool.calling
{ runtimeId, pluginId, toolName, toolCallId, label,
  arguments: string,                               // LLM-provided JSON original
  source: 'builtin' | 'local' | 'third-party',
  approvalStatus: ApprovalStatus }

// tool.completed
{ runtimeId, pluginId, toolName, toolCallId, label,
  result: string,                                  // LLM-facing (post `_text` rule)
  parsedResult: unknown,                           // full structured object
  durationMs, approvalStatus, success: true }

// tool.failed
{ runtimeId, pluginId, toolName, toolCallId, label,
  code: 'NOT_FOUND' | 'DENIED' | 'INVALID_ARGS' | 'VALIDATION_ERROR' | 'EXECUTION_ERROR',
  error: string, details?: string[],
  durationMs, approvalStatus, success: false }

// llm.calling
{ runtimeId, pluginId, slot, model, provider,
  messages: ChatMessage[],                         // full prompt (role/content/toolCalls/toolCallId)
  tools: Array<{ name, description, jsonSchema }>,
  attempt: number, temperature?, maxTokens? }

// llm.responded
{ runtimeId, pluginId, text?, toolCalls?,
  usage: { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheCreationTokens? },
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error' | 'timeout',
  durationMs, attempt, error? }

// message.completed
{ runtimeId, pluginId, content: string, len: number, deltaCount: number }

// block.emitted
{ runtimeId, pluginId, proposalId, source, block: Record<string, unknown> }

// state.patch.applied
{ runtimeId, pluginId, proposalId,
  patch: { packageName, summary, ops } }

// hook.fired
{ event: 'TurnStart' | 'PreToolUse' | 'PostToolUse'
       | 'PreStateCommit' | 'PostStateCommit' | 'TurnStop',
  hookName, pluginId, runtimeId?, targetId?,
  targetType: 'proposal' | 'toolCall' | 'turn' }

// hook.rewrote
{ event, hookName, pluginId, runtimeId?, targetId?,
  reason?: string,
  diff?: { before: unknown, after: unknown } }

// hook.aborted (already exists — align field names)
{ event, hookName, pluginId, runtimeId?, targetId?,
  proposalType?, reason: string }
```

**Full payloads are stored. No truncation.** Long `llm.calling.messages` entries (system prompts in the tens of thousands of tokens) and long `tool.completed.parsedResult` / `llm.responded.text` are persisted as-is. A future `COVEL_TRACE_TRUNCATE=1` environment switch can be added if row sizes become a problem in production — it is not in this change.

## Architecture

### `TurnEmitter`

A new small abstraction, created once per turn and threaded through the runtime context. Every `emit()` call does exactly two things:

```
createTurnEmitter({ store, eventBus, sessionId, turnId }): TurnEmitter
  ↳ emit(type, payload):
      1. store.addTraceEvent(...)                   // persist
      2. eventBus.emit({ type, sessionId, turnId, payload })   // broadcast
```

- `store.addTraceEvent` writes to the `trace_events` table (existing method; all four backends already implement it).
- `eventBus.emit` is the existing kernel-wide bus. `apps/server/src/routes/api/actions.ts` already subscribes via `eventBus.onEmit(...)` and forwards whitelisted types to the SSE stream — we add 11 types to `FORWARDED_SUBTYPES` and no new SSE code is needed.

The emitter is **created in `actions.ts`** right after the existing `createTraceRecorder` call (line ~235), alongside the turn lifecycle. `TraceRecorder` stays for its existing 5 lifecycle events (turnStarted / turnCompleted / runtimeStarted / runtimeCompleted / runtimeFailed) and is later refactored to delegate into `TurnEmitter` for consistency (non-blocking cleanup).

### Injection path

`TurnEmitter` is passed down as part of the existing context plumbing — **no constructor signatures change**:

- `executeTurn(input, runtimes, deps)` — `deps.emitter` added.
- `ToolCallContext` — `emitter` added (sits next to existing `pendingProposals`).
- `RuntimeContextView` — `emitter` added (for use inside runtime code that needs it, though most emits happen in framework code).
- `HookContext` — `emitter` added.
- `llm.generate(options)` — `options.emitter` added.

All additions are **optional** to preserve backward compatibility for third-party code that imports `ToolExecutor` or `LlmAdapter` directly — when `emitter` is absent, behavior is unchanged (no trace, no SSE).

### SSE wiring

`apps/server/src/routes/api/actions.ts` `FORWARDED_SUBTYPES` grows from 4 entries to 15 (existing 4 + 11 new). No other SSE code is added.

```
FORWARDED_SUBTYPES = {
  // existing
  'plugin-data.changed', 'world.dimensions.changed',
  'turn.suspended', 'turn.resumed',
  // new
  'tool.calling', 'tool.completed', 'tool.failed',
  'llm.calling', 'llm.responded',
  'message.completed',
  'block.emitted', 'state.patch.applied',
  'hook.fired', 'hook.rewrote', 'hook.aborted',
}
```

Note `message.delta` is **not** in this list — it continues to flow through the existing `narrative.delta` SSE path unchanged.

## Frontend changes (small)

`apps/web/src/routes/debug.tsx` needs about 40 lines of changes. Most of the rich rendering is already written and automatically activates once the events arrive.

| Location                   | Change                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `categorize()`             | Add `hook.` prefix → new `hook` category                                                                                                         |
| `CATEGORY_STYLES`          | Add `hook` entry with a distinct color (proposed: rose/pink) and icon                                                                            |
| `deriveRuntimesFromTurn()` | Aggregate events by `payload.runtimeId` regardless of envelope type; status still derived from `runtime.started / completed / failed` outer type |
| `TurnCard` (~557-559)      | Remove the `e.type === 'runtime.progress'` filter before calling derive — pass all events                                                        |
| `extractDetail()` switch   | No change — all existing cases apply directly                                                                                                    |
| `renderStructuredData()`   | No change for llm/tool — already implemented. Optional follow-up: add hook-specific renderer if time permits                                     |

Unknown-type events (old frontend meeting new events, or vice versa) already fall back gracefully to the `flow` category — no crashes either direction.

## Testing

| Layer                                             | Test                                                                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/tests/tool-executor.test.ts`    | Assert `emitter.emit` is called for `tool.calling` / `tool.completed` / `tool.failed` across success / Zod validation / approval-denied / not-found / JSON-invalid branches; payload shape matches schema |
| `packages/runtime/tests/llm-adapter.test.ts`      | Mock emitter; assert `llm.calling` carries messages/tools/slot, `llm.responded` carries text/toolCalls/usage/finishReason; retry attempts increment                                                       |
| `packages/runtime/tests/session-kernel.test.ts`   | `processRuntimeResult` emits `block.emitted` per `ui.render` proposal and `state.patch.applied` per `state.patch` proposal                                                                                |
| `packages/runtime/tests/hooks-pipeline.test.ts`   | `hook.fired` fires for every invocation; `hook.rewrote` fires on modification; `hook.aborted` unchanged                                                                                                   |
| New `packages/runtime/tests/turn-emitter.test.ts` | `emit()` both persists to store and broadcasts to eventBus; sessionId/turnId/seq injected correctly; failure of one path does not block the other                                                         |
| `scripts/e2e-plugin-verify.ts`                    | After turns complete, `GET /api/traces/:sid` returns a type-set that is a superset of `{ tool.calling, tool.completed, llm.calling, llm.responded, message.completed, block.emitted, hook.fired }`        |

All backends (`MemoryStore`, `SqliteStore`, `PgStore`, `IdbStore`) already implement `addTraceEvent` and pass `store-contract.ts` — no new contract tests needed for persistence.

## Migration

- **DB schema:** zero change. `trace_events.payload` is JSONB/TEXT.
- **Historical sessions:** not back-filled. Existing sessions such as `mistport-6d37b552` keep their 5 event types.
- **SSE contract:** envelope format unchanged, only the type whitelist grows. Clients that don't recognize a new type fall through to the `flow` category.
- **`TraceRecorder`:** retained unchanged for its current 5 events. Optional follow-up: migrate it to use `TurnEmitter` internally for consistency — not in this PR.
- **Documentation sync (per CLAUDE.md policy):**
  - `docs/reference/protocol.md` — append the 11 new SSE event types with payload schemas.
  - `docs/architecture/flow.md` — update the Observability section's trace event inventory.

## Risks

| Risk                                                                               | Mitigation                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.calling.messages` inflates `trace_events` table (5-20 MB per long turn in PG) | Accepted for now per explicit decision. Future `COVEL_TRACE_TRUNCATE` env switch can opt-in truncation.                                                        |
| High-frequency hooks (e.g. a default no-op PreToolUse) flood the timeline          | Observe post-merge; if noisy, promote `hook.fired` to only-when-modified (drop fires that produce no rewrote/aborted). Spec optional follow-up.                |
| Third-party `ToolExecutor` / `LlmAdapter` consumers not passing `emitter`          | All emitter parameters are **optional**; absent emitter → no trace, no SSE, no error. Preserves existing behavior.                                             |
| SSE stream back-pressure with many events                                          | `stream.writeSSE(...).catch(() => {})` is already used for tolerant pushes; new events follow same pattern. Events still persist to DB even if SSE push fails. |

## Open questions

None at spec time. If implementation reveals ambiguity, the plan (generated by `writing-plans` next) resolves them per-task.

## Success criteria

1. A new session's `GET /api/traces/:sid/turns` response contains ≥ 8 distinct event types across a representative turn (runtime lifecycle + tool + llm + message + block + hook).
2. Opening `/debug` for a new session with the frontend changes shows:
   - Tool calls with full arguments and structured results.
   - LLM call records with the full prompt messages and response text / tool-call / usage.
   - Narrative content inlined as one entry per runtime (no per-token noise).
   - Block emissions and state patches as dedicated entries.
   - Hook activity with event name + target.
3. Existing `runtime.started / runtime.completed / proposal.committed / turn.started / turn.completed` continue to appear unchanged.
4. Unit and E2E tests enumerated above all pass.
