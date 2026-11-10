# Story Context Probe

A standalone community package for the `story-context@1` kernel input. It is
not bundled with the product; `apps/server/tests/api/story-context-probe.test.ts`
uploads it as a ZIP through the real install API, enables it, approves its
runtimes and plays a turn with a scripted model.

| Runtime | Stage | What it shows |
| --- | --- | --- |
| `story-context-probe/clock` | `pre-turn` | `io.storyContext` with `select` and `priority: high` |
| `story-context-probe/omen` | `pre-turn` | a concealed provider with a titled note; the trace keeps its title only |
| `story-context-probe/quiet` | `pre-turn` | `null`: nothing to say, no note |
| `story-context-probe/story` | `narrative` | a function story that reads `from: { kernel: story-context@1 }` and writes one paragraph per note |

The story provides `narrative-engine@2`, so enable it in a session without
another story provider.
