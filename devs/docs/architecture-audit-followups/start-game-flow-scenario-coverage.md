# Start Game Flow Scenario Coverage

Date: 2026-04-25

These follow-up tests pin the start-game lifecycle from bootstrap through character creation:

- `packages/runtime/tests/start-game-flow-scenario.test.ts`
- `apps/server/tests/api/start-game-flow-scenario.test.ts`

## Covered Lifecycle

1. Fresh session starts at `turnCount: 0` with Pre-Game runtimes active.
2. `start_session` runs bootstrap and produces the character form.
3. Bootstrap keeps player message history empty.
4. Pending form keeps the session in setup state.
5. Submitted form values resume `char-creator/player-init`.
6. Player creation writes the character record and the character panel mirror.
7. Main-loop narrator runs in the same turn after player creation and setup completion.

## Integration Status

- Package A owns bootstrap history, Pre-Game continuation, and route-owned `turnCount` drift.
- Package B owns player mirror persistence for guard-created players.
- Package C metadata work has separate ownership, so these scenario tests avoid package metadata assertions.

After Packages A and B land, these tests pass as cross-layer regression coverage for the fresh-session happy path.
