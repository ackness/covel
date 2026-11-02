# Scripted sessions for replay

Each directory describes one scripted session. Recordings stay local under its gitignored `recording/`; replay calls no model and fails if any exact request digest is missing. Never edit captured responses, invent compatibility aliases or loosen matching.

- `scenario.json` supplies `world`, `turns`, `locale` (default `zh-CN`), fixed `sessionId`, `seed` and additional verification `args`.
- `llm.toml` names the recording's models. Every `[covel.<slot>]` needs `provider` and `baseUrl`; the runner points it at the proxy.
- `recording/` contains original responses keyed by request digest and is never committed.

Agent completion uses `submit-output` alone. Business work precedes submission; reply content is not success. Lantern Barrow requires a successful submission trace. New tools, schema placement, prompts, review feedback, plugin versions and step counts invalidate affected agent recordings. Re-record Lantern Barrow first and every other capture containing agent requests. Preserve old evidence separately under its original revision; retain compatible committed story history.

With the intended supported local model configuration and existing credentials in the environment or `.env.llm`, run:

```bash
flock /tmp/covel-e2e.lock pnpm e2e:replay --record lantern-barrow
flock /tmp/covel-e2e.lock pnpm e2e:replay
```

Recording forwards new requests to `DEFAULT_BASE_URL`, an OpenAI-compatible origin without `/v1`, or an explicitly supplied `--upstream <origin>`. Keys are read under the provider name in `llm.toml` (`default` uses `DEFAULT_API_KEY`). Existing exact matches are reused; a completed recording removes unused answers. Replay must then match all requests. Configure a model the endpoint actually serves; no provider capability is proven by this file.

The runner owns an isolated server/database/home, fixed seed and UTC. It does not inherit the shell's server settings. Logs and request bodies remain local under `debugs/llm-replay/`; do not publish them without removing credentials, endpoint identity and concealed/private content. A fresh recording is separate from [natural and injected model acceptance](../../docs/en/ship/real-model.md#submission-acceptance), whose commits require receipt and message/proposal readback. Coordinator owns all recording, model and browser runs.
