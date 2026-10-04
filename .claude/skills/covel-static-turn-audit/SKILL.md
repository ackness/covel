---
name: covel-static-turn-audit
description: "Static audit of Covel's runtime scheduling by reading code and reasoning about it, without starting the app or calling a model: plugin manifests first, then plugin-to-plugin edges, the kernel scheduler, commit and background jobs. Treats each LLM call as an unknown with a closed set of outcomes, checks hard logic with small input/output scripts, and reports counterexample traces under devs/audits/, with an HTML block-diagram map on request. Use only when the user explicitly asks for a static turn-flow or scheduling audit, or for this skill by name."
---

# Covel Static Turn Audit

Find scheduling faults by reasoning about the code instead of playing through it. The app never starts and no model is called, so the audit can cover executions a real run seldom shows: a model that returns the wrong shape, an upstream that fails, two actors that interleave. Reading comes first; where a piece of logic is too intricate to settle by reading, a small script checks its inputs against its outputs.

Three rules shape the method:

- **The model is an unknown, not a step.** Never guess what an LLM would answer. Replace each agent runtime with the set of ways its execution can end, and ask what the framework does for each one.
- **Work from the outside in.** Plugins state what they assume; the kernel must make each assumption true. Start at the plugins and carry every assumption inward until code discharges it or nothing does.
- **A finding is a counterexample.** It is a concrete sequence of states and outcomes that ends in a broken property, with a line of code behind every step.

The pipeline is not copied here. `docs/architecture/flow.md` and `docs/architecture/design-principles.md` state what the framework promises, the manifests state what plugins assume, and the code states what happens. Identifiers below are search anchors; when one no longer matches, find its successor through the Search Map in `docs/README.md`.

## Operating Rules

- `AGENTS.md` and nested instruction files take precedence.
- Never start the app or call a model: no dev server, app session in a browser, provider request, playthrough, e2e harness, build, or test suite. What may run: `rg`, `git`, file reads, logic probes (below), and analysers that only parse source (`pnpm deps:check`, `pnpm analyze`, `pnpm validate:plugin plugins/<id>`), whose output is a lead, not a conclusion.
- Write only the report and its evidence files. Do not change product source, `docs/`, or tests.
- Record the baseline first: audited path, `git rev-parse HEAD`, `git status --short`, and whether uncommitted changes are in scope.
- Use subagents only when the user explicitly asks for parallel work.
- Write the report in the language the user writes in.

## Logic Probes

A probe is a short script that feeds chosen inputs to one piece of logic and prints what comes out. Write one when reading cannot settle the question: the levels a DAG resolves to, a branch table with many input classes, a schema-compatibility check, an interleaving of two actors. It supports the reasoning and does not replace it.

- **Call the real code when possible.** Import the function from source by relative path, not by package name, build the inputs by hand, and print each input with its output.
- **Otherwise model the logic** in a standalone JS or Python script that enumerates the cases. A model proves something about the model only: each rule in it cites the line it mirrors, and its result is a lead until a line or a real-code probe confirms it.
- **The model stays an unknown.** A probe may pass a fake adapter that returns the outcome under study. It never calls a provider.
- Keep it deterministic and finished in seconds: no network, no provider keys, no real database or user data — an in-memory store at most.
- A probe that shows a fault asserts the faulty behaviour, so it exits 0 while the fault exists and fails once it is fixed. Say in its first comment what it asserts.
- Keep the script and its log together in `debugs/audits/<slug>/`, never in a tracked folder or a test suite. Relative imports resolve inside the checkout the script sits in, so to probe a worktree put the script at the same depth inside that worktree.

```bash
env -u DATABASE_URL mise exec -- pnpm exec tsx debugs/audits/<slug>/<probe>.ts > debugs/audits/<slug>/<probe>.log 2>&1
```

## Audit Map

When the user asks for a diagram or an overview, add `map.html` to the report folder: block diagrams of what each part of the code does and how the parts relate. Copy `assets/audit-map.html` from this skill and replace only the JSON in `#diagram-data`; the page places the blocks and routes the arrows.

- Build it right after step 2, from the model. Filling it in is a check on the model: a block with no relation, or an arrow you cannot cite a line for, is a gap to close before the layer reasoning.
- Draw several small diagrams, not one large one: an overview with one block per module, then one diagram per part of the walk (setup, the main-loop stages, commit, background work). Keep each to about twelve blocks and fifteen arrows, five blocks to a row at most.
- Every block says what it does in one sentence and cites where it lives. Point one arrow at a whole row (`@<layer id>`), not one at each block in it, and number the arrow labels in execution order.
- When the findings are settled, add each to the diagram it concerns.
- The page draws with ECharts from cdn.jsdelivr.net and lists the same content as text when that does not load. It names inconsistent data in a banner at the top. Opening the file to look at it is reading the report, not starting the app.

## Workflow

### 1. Scope And Context

Confirm or infer: the target tree, the world and plugin set to reason about (default: one bundled world with the set its `pluginPolicy` and pack resolve to), the layers in scope (default: all four), and any focus the user named.

Read `flow.md`, `design-principles.md`, `docs/glossary.md`, `docs/reference/plugins.md`, and `docs/architecture/technical-debt.md` — a limit recorded there is not a finding. Earlier audits under `devs/audits/` and `devs/docs/audits/` are leads: re-check each against current code, and do not re-report what the user deferred.

### 2. Fix The Model

Write down what the reasoning ranges over before reasoning. Take every item from this baseline's code and manifests, never from memory or an earlier audit.

- **Runtimes.** The active set as `resolveSessionPlugins` (`packages/shared/src/plugin-selection.ts`) computes it. For each runtime: `type`, trigger, `schedule.stage`, `needs` / `after` / `io.inputs` and which inputs are required, `schedule.completion`, declared `effects`, tools, `io.visibility`.
- **Schedule.** DAG levels per stage (`setup`, then `pre-turn` → `narrative` → `post-turn` → `audit`). Stage-less runtimes (`manual` / `event`) apart, each with what activates it.
- **Outcome set.** Every way one runtime execution can end, read from the places `packages/runtime/src/` assigns a terminal status: `agent-loop/`, `function-runtime/`, `turn-executor/runtime-finalization.ts`, and the gates in `schedule/input-bindings.ts`. Expect at least: accepted output; output that fails validation; a required tool that never succeeds; step budget spent; loop detected; each timeout; provider error after retries; a hook that rejects or terminates; player abort; suspension; a function handler's `success` / `skipped` / `suspended` / `failed`, a throw, or an invalid result; a guard that skips; a gate skip.
- **State.** The session clock (`status`, `phase`, `completedPlayerTurns`, `setupRuntimes`), `logicalTurn` and execution `origin`, trigger ledger counts, committed outputs, plugin data, queued jobs, suspensions.
- **Actors.** Whatever can act at the same time: a player action, plugin-rpc, resume, retry, the job worker, hot reload, pause and end.
- **Properties.** What must always hold. Seeds — confirm each wording against the docs, then add what the plugins themselves assume:
  - a runtime never starts before its `needs` targets of the same pass succeeded, and a stage never starts before the previous one settled;
  - order inside a stage comes only from declared edges, then `name`;
  - a failed execution commits nothing partial, and a runtime whose writes are dropped takes its hard dependents with it;
  - each committed player execution counts once, and no other origin counts;
  - `phase` leaves `setup` only when every setup runtime is done or waived, in the transaction that commits their writes;
  - a background result never commits into a session, plugin, or version it was not computed for;
  - every runtime ends in exactly one terminal status and every execution in one `execution.completed`;
  - the session can always progress, or shows the player why it cannot;
  - removing any optional plugin leaves the framework working.

### 3. Layer A — Each Plugin Alone

- Declared against used: tools the prompt body names against `agent.tools`, proposals a handler builds against `effects`, `entry` registrations against `contributes`.
- For each outcome of its own runtimes, what state the plugin is left in. Look for an outcome that leaves its data half-written or a setup runtime never done.
- Assumptions it makes but does not declare — another runtime already ran, last turn's data exists, the player character exists, this is not the first turn. Each one is an obligation to carry into layers B and C.
- Setup runtimes: every path reaches done, blocked, or a visible wait; the guard skips work already done when a `version` change re-runs setup.
- Cadence at its boundaries: `startTurn`, interval, cooldown, `maxTriggerCount`.

### 4. Layer B — Between Plugins

- Each `needs`, `after`, `io.inputs`, and contract edge under four cases: provider absent, provider skipped or failed, two providers, provider replaced by another package.
- Committed-scope reads on the first execution, when nothing is committed yet.
- Events: a topic emitted with no subscriber, a subscriber with no emitter, one topic emitted twice in one execution.
- Services and extension points called but not registered in this active set; a `single` point with two providers.
- Two runtimes in one DAG level that touch the same resource with no edge between them (`schedule/effects.ts`).
- Order a prompt or handler relies on that no manifest edge declares.
- Ablation: remove each optional plugin in turn and name the assumption that breaks. Flag framework code that branches on a plugin ID.

### 5. Layer C — Kernel Scheduling

Build a branch table for each decision function, with the input classes of the model as rows: `selectTriggeredRuntimes`, `shouldTrigger`, the gates in `input-bindings.ts`, `scheduleTriggeredRuntimes` and `dag-scheduler.ts`, the detachment plan in `turn-completion.ts`, `runEventChain`, and setup completion (`setup-completion-tracker.ts`). Look for a class no branch handles, a class two branches both claim, a branch no input reaches, and a manifest field no branch reads. The last two are the dead code. A table too large to fill by reading is a case for a probe that enumerates the classes against the real function.

Then substitute outcomes: for each runtime and each outcome, follow the effect on its own level, later levels, later stages, event followers, the setup mirror, the story-output check, and what the player's stream has already shown.

Walk the boundaries: the first execution with an empty message, the input that completes the last setup runtime and the opening continuation after it, the first counted turn, each cadence boundary, a manual target, a retry of one runtime and of a whole turn.

### 6. Layer D — Commit, State, Background

- Atomicity (`commit/finalize-execution.ts`, `commit-dependencies.ts`): what one transaction covers, which failures drop one runtime and which roll back the execution, and what the player already saw of text that rolls back.
- Clock (`commit/session-clock.ts`): every writer, and executions that share one logical turn.
- Interleavings: for each pair of actors, walk the await points outside the session lock (`settled-request.ts`, `runtime-job-worker.ts`, `resume/turn-resume.ts`). Look for state read before the lock and acted on inside it, and for a result that arrives after a pause, an end, a plugin removal, or a version change.
- Liveness: a state no action leaves — setup blocked with no retry or waiver, a job that never reaches a terminal status, an event chain that re-triggers itself, a retry that rebuilds the same failure.
- Carry-over: walk three consecutive player turns and name what each reads that the one before wrote — plugin data, `recordAs` outputs, settled jobs, ledger counts.

## Findings

Each finding states the broken property, the trace (initial state, then steps that each name the actor, the outcome chosen, and the line that permits it, then the end state), the effect in words a player or plugin author would recognise, and a direction for the fix.

- Evidence: `by reading`, or `by probe` with links to the script and its log. A probe on real code may stand in for a line; a standalone model may not.
- Trigger class: `always` for this plugin set, `model-dependent` (needs an outcome the loop permits), `timing-dependent` (needs an interleaving), or `third-party-only` (no bundled plugin has the shape).
- Severity: `P1` wrong behaviour or data risk on a path players reach; `P2` edge-path risk, growth in cost or storage, doc drift; `P3` cleanup, naming, stale comments.

A trace with a step that neither a line nor a real-code probe supports is an open question, not a finding: list it apart with the fact that is missing. Before claiming something is absent or never called, search a second time through callers, tests, and plugins. Record the properties that hold together with the argument for each. Finding IDs stay in the report and never go into code comments or `docs/`.

Neither reading nor a probe can say how often a model produces an outcome, how long anything takes, or how a provider behaves. Mark those by trigger class; do not estimate them.

## Report

Write to `devs/audits/<YYYY-MM-DD>-<short-slug>/` in the main checkout (gitignored, so a worktree has no such folder; name the worktree path and HEAD in the baseline when it is the target). Probes, their logs, and analyser output go to `debugs/audits/<same-slug>/` and stay there as supporting material.

- `README.md`: baseline, scope, conclusion, finding table, open questions, everything that ran (each probe with what it asserts), and the limits above.
- `01-model.md`: runtimes, schedule table, outcome set, state, actors, properties.
- `02-reasoning.md`: layers A to D — branch tables, substitutions, interleavings, and the properties that hold.
- `03-findings.md`: one counterexample trace per finding.
- `map.html`: the audit map, when the user asked for one.

A narrow audit may keep everything in `README.md`. Cite code as `path:line`, written as a Markdown link relative to the report folder (`../../../packages/...#L120`).

## Evidence Commands

```bash
git rev-parse HEAD && git status --short
rg -n --sort path "^\s*(stage|needs|after|mode|settle|visibility):|^\s+type: (auto|manual|scheduled|event)$" plugins -g PLUGIN.md -g RUNTIME.md -g '!**/_archive/**'
rg -n "selectTriggeredRuntimes|scheduleTriggeredRuntimes|runEventChain|markPreGameCompletion|finalizeExecution|withSettledExecutionLock" apps packages -g '!*.test.*'
rg -n "status: \"(success|failed|skipped|suspended)\"|skipReason: \"|outcome: \"" packages/runtime/src/agent-loop packages/runtime/src/function-runtime packages/runtime/src/turn-executor packages/runtime/src/schedule -g '!*.test.*'
```

Both scans are indexes of where to read. The first is not the schedule, because edges span several lines; the last is not the outcome set, because one status line can stand for several causes. Read each file.

## Completion Check

1. The model is written down and every item in it cites this baseline.
2. Each layer in scope has its reasoning recorded, including what holds.
3. Every finding is a full trace with a line or a real-code probe behind each step; anything less is listed as an open question.
4. Every outcome in the outcome set was substituted at least once, or the report says why not.
5. Each probe sits in `debugs/audits/<slug>/` beside its log, and the README lists it. A map, if asked for, shows no data banner and agrees with `01-model.md`.
6. The app never started and no model was called, and `git status --short` shows no tracked change caused by the audit.
