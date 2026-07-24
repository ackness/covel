---
name: covel-static-turn-audit
description: "Static Covel audit for start-game, plugin activation, runtime scheduling, prompt assembly, SSE/commit flow, multi-turn simulation, and dead-code findings under audits/."
---

# Covel Static Turn Audit

## Overview

Perform a code-only Covel gameplay-flow audit from the first start-game click through plugin selection, session creation, the setup stage (`phase === "setup"`, historically "Pre-Game"), prompt/runtime orchestration, and at least three main-loop turns. Produce repository audit artifacts with evidence-backed expected-vs-actual findings.

## Operating Rules

- Follow repository-local `AGENTS.md`, `CLAUDE.md`, `RTK.md` (when present), and closer instruction files before this skill.
- If the user requests a static audit or says not to run the program, do not start dev servers, browsers, tests, builds, or model calls. Use read-only shell inspection plus Markdown file writes.
- Use `rtk` for shell commands only when a repository-local rule file requires it; otherwise plain shell commands are fine.
- Use `rg`/`fd` or local equivalents for discovery, and `nl -ba ... | sed -n` for line-backed evidence.
- Use `apply_patch` for audit file creation and edits.
- Preserve unrelated worktree changes. Check `git status --short` before edits and before final reporting.
- Use subagents only when the user explicitly asks for parallel agent work.

## Workflow

### 1. Establish Scope

Confirm these inputs from the user request or infer conservatively:

- Target repo, normally `/Users/wuyong/codes/game/covel`.
- Whether the audit is static-only.
- Starting user action, usually first `Start Game` in the prep screen.
- Required simulation depth, usually Turn0 plus at least Turn1/Turn2/Turn3.
- Output location, normally a new directory under `audits/`.

If the user asks for "当前审计流程", create a reusable audit method, not a one-off conclusion list.

### 2. Load Local Context

Read only the context needed for the audit:

- `AGENTS.md`, `CLAUDE.md`, `RTK.md`.
- Relevant architecture docs, especially `docs/architecture/flow.md`, `docs/reference/plugins.md`, `docs/reference/api.md`, `docs/reference/protocol.md`.
- Existing `audits/` folders to avoid duplicate names and learn prior framing.
- Memory entries for Covel when available, especially world-data, manual-trigger, plugin runtime docs, storage, and prior audit follow-through notes. Treat memory as hints; verify current code when cheap.

### 3. Map The Start Path

Trace from user interaction to server state:

1. Prep UI button and plugin payload.
2. Session store `startGame` / `startGameSession`.
3. API client `createSession`.
4. Server `POST /api/sessions`.
5. Plugin resolution, core plugins, packs, world policy, relations/conflicts.
6. worldData/session import and fallback blueprint import.
7. Registry activation and hydrated UI state.

Separate "create session" from "execute first turn". In Covel the prep `Start Game` creates the session; GameView `Begin Adventure` starts Turn0.

### 4. Map The Action Runtime Path

Trace `/api/actions` and executor orchestration:

1. Supported action types and payload normalization.
2. `start_session` empty `playerMessage` and `suppressPlayerMessage`.
3. Active runtime lookup and plugin activation after restart.
4. SSE forwarded subtypes and frontend SSE handling.
5. `executeTurn` session lock, hooks, session state load (frozen `logicalTurn = completedPlayerTurns + 1`), trigger selection (`selectTriggeredRuntimes`: manual name-match bypass / setup mirror-pending + `needs(scope: session)` gate / main-loop `shouldTrigger`), per-stage DAG scheduling (`setup` single DAG; main loop `pre-turn → narrative → post-turn → audit` with strict barriers), runtime execution (turn-scope upstream gate + `inputs` bindings), event-chain followers (fan-out is name-ordered and not stage-barriered), setup completion mirroring, finalization, commit processing.
6. Turn counting is single-writer: the finalize transaction writes the session clock (`phase` / `completedPlayerTurns` / `setupRuntimes`) and the logical-turn ledger guarantees at-most-once counting; `markPreGameCompletion` only collects newly-done setup mirrors (it does not write counts), and the legacy `turnCount` / `preGameCompleted` are derived at read time. Also check the opening continuation in `/api/actions`: the request that completes the LAST setup runtime chains exactly one main-loop turn on the same SSE stream.

### 5. Map Prompt And Commit Semantics

Inspect:

- Prompt segments and current-turn user-message fallback.
- `assemblePromptVariables` for `world`, `session`, `player`, `inputs`, `userSettings`.
- Runtime output normalization: story narrative, interactions, notifications, pluginData, ui blocks, pending proposals.
- Commit handlers and emitted session events.
- Frontend reducer/SSE behavior for message, block, plugin-data, character, suspension, asset, and execution events.

### 6. Simulate Turns

Use an expected/actual/delta/effect/evidence structure. At minimum simulate:

| Phase | Meaning |
| --- | --- |
| Prep Start Game | Session creation, plugin selection, worldData import; `phase` initialized from whether the active set declares a setup runtime; no turn execution. |
| Turn0 / start_session | Setup stage only (`phase === "setup"`), normally `pregame`, `world-init/schema-gen`, `char-creator/player-init` — DAG-ordered by `needs` plus the conservative legacy chain; narrator never runs. |
| Turn0b / form submission | `framework/submit-form` (plugin-rpc) writes `player_inputs`, then filled narrative triggers `send_message`; the guard synthesizes the player deterministically and reports done. When the LAST setup runtime completes, the finalize transaction flips `phase` to `playing` and the **opening continuation** chains exactly one main-loop turn in the same request (narrator opening without another player message). |
| Turn1 | First normal main-loop player message: `pre-turn → narrative → post-turn → audit` with strict barriers; downstream gates use `needs: [capability: narrative-engine]`. |
| Turn2 | Second normal main-loop message, using state written by Turn1 (plugin-data injects, extractor increments). |
| Turn3 | Third normal main-loop message, verifying `phase` stays `playing` and the per-stage schedule repeats identically. |

For each phase, check whether traditional-story and dialogue-mode branch differently:

- Traditional path: retrieval -> narrator -> guide/codex/npc graph extractor/character tracker.
- Dialogue path: retrieval + scene-cast -> chat-mode-narrator -> scene-prompts and enabled trackers.
- The two narrators are mutually exclusive via `relations.conflicts`; downstream plugins gate on `capability: narrative-engine` so both modes share one declaration.
- Manual plugins such as identity/profile or branch reply require plugin-rpc/manual triggers; active does not mean auto-scheduled (manual/event runtimes declare no `stage`).

### 7. Identify Dead Or Redundant Code

Search for candidates across app, server, packages, plugins, docs, and audits:

- Duplicate turn entrypoints.
- Frontend action types unsupported by server.
- Manifest fields accepted by schema but consumed by no execution surface (the historical trap was reserved trigger types; the modern shape is scheduling fields like `scope` / `cardinality` on paths that don't read them).
- Exported APIs with no production callers.
- Hardcoded plugin IDs in framework code.
- Runtime completion or turn-count code called in multiple places.
- Debug logs in normal plugin paths.
- UI-only/manual runtimes that users might assume are automatic.
- Docs that describe older flow or omit current behavior.

Classify findings:

- `P1`: architecture or behavior risk likely to mislead future implementation.
- `P2`: compatibility, UX, doc drift, or maintenance risk.
- `P3`: cleanup, logging, naming, or clarity issue.

## Recommended Audit Artifacts

Create a new folder:

```text
audits/<YYYY-MM-DD>-<short-slug>/
```

Use these files unless the user requests a different structure:

- `README.md`: scope, method, key conclusions, boundaries.
- `01-static-flow-map.md`: click-to-session-to-action flow with expected/actual notes.
- `02-turn-simulation.md`: Turn0, Turn0b, Turn1, Turn2, Turn3.
- `03-findings-and-dead-code.md`: prioritized findings and cleanup candidates.
- `04-evidence-index.md`: code/doc line references used by the report.

Keep reports factual and line-backed. State explicitly that the audit is static and unexecuted.

## Evidence Commands

Use targeted reads; avoid huge bundles:

```bash
rtk git status --short
rtk rg -n "startGameSession|beginAdventure|sendMessage|resolveSessionPlugins|executeTurn|markPreGameCompletion|submit-form" apps packages plugins docs
rtk nl -ba <file> | sed -n '<start>,<end>p'
```

Prefer current source over old audit notes. Use old audits only to identify prior known risks or terminology.

## Completion Check

Before final response:

1. Confirm the audit directory and files exist.
2. Confirm each user-required phase is covered: first button, plugin enablement, plugin runtime logic, Turn0, at least three subsequent turns, prompt/framework orchestration, docs angle, redundant/unused code.
3. Confirm no program/test/build/server was run when the user requested static-only.
4. Re-check `git status --short` and report created files plus any unrelated existing changes.
