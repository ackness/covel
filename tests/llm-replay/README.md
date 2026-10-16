# Scripted sessions for replay

Each directory is one scripted session. `pnpm e2e:replay --record` records the
model answers into its `recording/`, and `pnpm e2e:replay` plays them without
calling a model; the run fails when a request is not in the recording.
Recordings stay on this machine (`recording/` is gitignored): record on `main`
before a change that should not touch any prompt, then replay after it.

- `scenario.json` — what `scripts/e2e-plugin-verify.ts` plays: `world`,
  `turns`, `locale` (default `zh-CN`), `sessionId`, `seed`, and further
  arguments in `args`.
- `llm.toml` — the models of the recording. Every `[covel.<slot>]` needs a
  `provider` and a `baseUrl`; the run points each `baseUrl` at its proxy.
- `recording/` — one answer per request, named after the request digest; not committed.

Record before the first replay, and again after a change to a world, plugin,
prompt or `llm.toml` (about 4 minutes for lantern-barrow).

Recording sends every new request to the OpenAI-compatible endpoint you set
in the environment or `.env.llm`; any provider works:

```bash
DEFAULT_BASE_URL=https://api.example.com   # the origin, without /v1
DEFAULT_API_KEY=sk-...
pnpm e2e:replay --record lantern-barrow
```

`--upstream <origin>` overrides `DEFAULT_BASE_URL`. The key is read under
the provider's name in `llm.toml` (`default` → `DEFAULT_API_KEY`); the
model is the one `llm.toml` names, so a gateway must serve it. Details:
`docs/ship/real-model.md`.
