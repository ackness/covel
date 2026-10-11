# Recorded scripted sessions

Each directory is one scripted session with the model answers it was recorded
with. `pnpm e2e:replay` plays them without calling a model; the run fails when
a request is not in the recording.

- `scenario.json` — what `scripts/e2e-plugin-verify.ts` plays: `world`,
  `turns`, `locale` (default `zh-CN`), `sessionId`, `seed`, and further
  arguments in `args`.
- `llm.toml` — the models of the recording. Every `[covel.<slot>]` needs a
  `provider` and a `baseUrl`; the run points each `baseUrl` at its proxy.
- `recording/` — one answer per request, named after the request digest.

After a change to a world, plugin, prompt or `llm.toml`, record the session
again and commit `recording/` with the change:

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
`docs/guide/e2e-plugin-verify.md`.
