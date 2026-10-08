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

```bash
pnpm e2e:replay --record --upstream https://api.deepseek.com lantern-barrow
```

The key is read from the environment or `.env.llm` under the provider's name
(`DEEPSEEK_API_KEY`). Details: `docs/guide/e2e-plugin-verify.md`.
