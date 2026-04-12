# DAG Scheduler — Option B (frozen design)

**Status:** Frozen. Not scheduled for implementation.
**Date frozen:** 2026-04-12
**Reason frozen:** The original implementation of `extractDependencies` / `detectCycles`
was committed to `packages/runtime/src/scheduler.ts` but was never wired into
`turn-executor.ts`. The pure-priority `scheduleByPriority` path is sufficient for
current Covel use cases. The dead code was removed in S1-T4 to stop misleading
readers. This document preserves the design intent so it can be revisited if
Suspend/Resume (S4-T4) or future conditional routing needs materialize.

## Motivation (recap)

In the current architecture, plugins are scheduled by a pure numeric priority (0–1000)
inside `turn-executor.ts`. Same-priority plugins run in a parallel group
(`executeParallel` + `Promise.allSettled`). Dependency edges between plugins are
declared implicitly via `input.inject[]` (consuming upstream output) and
`input.tools[]` (requiring a shared tool), but the scheduler ignores those
declarations — correct ordering is an *emergent property* of the priority numbers
chosen by plugin authors.

Option B would replace (or layer on top of) pure-priority scheduling with a real
topological sort:

1. Extract edges from each runtime's manifest (inject + tool consumers → producer).
2. Detect cycles; fail fast with a structured error listing the offending cycle.
3. Topological-sort. Break ties within one topological "level" by priority number,
   so the existing priority semantics remain a fallback ordering.
4. Execute each topo level as a parallel group.

## Why deferred

- No current plugin pairs require DAG scheduling — priority numbers are sufficient.
- Adding a real topological sort requires a careful migration path: if any
  existing plugin pair relies on "implicit" priority ordering that would conflict
  with a declared inject edge, flipping behavior mid-project risks surprising
  regressions.
- The conditional-routing use cases that would benefit from DAG edges (e.g.
  "plugin A only runs if plugin B flagged X") are better served by the Guard
  mechanism (condition → skip), which is already in place.
- Sprint 4's Suspend/Resume work may surface a real need for conditional
  routing. That is the right moment to revisit this design.

## Re-activation criteria

Consider reviving Option B only if one of the following is observed:

1. Multiple plugin pairs develop non-trivial ordering requirements that cannot
   be expressed by priority numbers without introducing magic gaps.
2. Suspend/Resume (S4-T4) exposes a need to route control flow between plugins
   based on runtime state (not just priority + guard).
3. A plugin author reports a concrete ordering bug that `scheduleByPriority`
   cannot express.

## Original algorithm (historical reference)

The deleted functions in `packages/runtime/src/scheduler.ts` (pre-S1-T4) were:

### `extractDependencies(runtimes): readonly DependencyEdge[]`

Walked every `RuntimeManifest` and emitted one `DependencyEdge { dependent, dependency }`
per declared input source:

- For each entry in `input.inject[]`, emitted `{ dependent: rt.name, dependency: inj.from }`.
  The `from` field referenced an upstream runtime by its full `runtimeId`.
- For each entry in `input.tools[]`, emitted
  `{ dependent: rt.name, dependency: `${tool.plugin}/${tool.runtime}` }`.
  This treated a tool reference as an implicit dependency on its providing runtime.

Runtimes with no `input` declaration contributed no edges. The output was a flat
edge list, not an adjacency map — downstream code rebuilt adjacency as needed.

### `detectCycles(edges): readonly (readonly string[])[]`

DFS-based cycle detection on the flat edge list:

1. Built an adjacency map `Map<string, string[]>` from the edge list, also
   collecting the full node set (union of `dependent` and `dependency`).
2. Maintained two sets: `visited` (nodes fully explored) and `inStack` (nodes
   on the current DFS path).
3. Recursive `dfs(node, path)`: pushed `node` onto `path` and `inStack`, walked
   each neighbor. If a neighbor was already in `inStack`, sliced the path from
   the neighbor's index to the current tail and recorded it as a cycle. If a
   neighbor was unvisited, recursed. On return, popped `node` from both `path`
   and `inStack`.
4. Ran DFS from every unvisited node to cover disconnected components.

Return value was an array of cycle paths (each a `readonly string[]`), empty
when the graph was a DAG. No edges → `[]`. Self-loops and mutual cycles were
both captured by the `inStack` check.

Notes on what the code did *not* do:

- It did not perform a topological sort. Option B would need a second pass
  (Kahn's algorithm or DFS post-order) once cycles were ruled out.
- It did not integrate tie-breaking by priority. Option B's "priority within
  topo level" rule is new design, not present in the deleted code.
- It did not validate that `inject.from` or `tool.plugin/runtime` actually
  resolved to a loaded runtime. Option B should add that validation.

See the commit history of `packages/runtime/src/scheduler.ts` prior to S1-T4
for the exact deleted source.

## Out of scope

- Conditional routing (`Command(goto=...)` style dynamic dispatch). That is a
  separate concept orthogonal to DAG ordering and should have its own spec when
  the need is concrete.
