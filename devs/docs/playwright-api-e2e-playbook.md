# Covel Playwright/API E2E Playbook

## Purpose

This playbook records the repeatable browser + HTTP + database trace flow for validating session gameplay. Use it when a plugin change touches character creation, chat mode, right-panel UI, runtime scheduling, or persisted session state.

## Preconditions

- Dev server is running at `http://localhost:5173`.
- Health check passes:

```bash
curl -sS http://localhost:5173/api/health
```

- `npx` exists for the Playwright CLI wrapper. When the wrapper tries to install from npm and network is blocked, use the repository dependency directly:

```bash
node --input-type=module -e 'import { chromium } from "playwright"; console.log(!!chromium);'
```

## Local Pitfalls

- The Vite app serves HTML for unknown non-API paths. Use `/api/worlds`, `/api/plugins`, and `/api/framework/capabilities` for HTTP checks through `http://localhost:5173`; legacy smoke tests that call `/worlds` or `/packages` will parse `index.html` as JSON and fail with `Unexpected token '<'`.
- If `pnpm dev` reports `EADDRINUSE` for `3001` or Vite moves from `5173` to another port, first check whether an existing server is already healthy:

```bash
curl -sS http://localhost:5173/api/health
lsof -nP -iTCP:3001 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

- Discovery/debug checks should include plugins with i18n metadata objects. The `/debug` session-data view must resolve `name` / `description` objects before rendering them; a raw object child will crash React with `Objects are not valid as a React child`.
- Locale and onboarding are stored in the unified `covel:settings` bundle under `entries`. Legacy keys such as `covel:locale` and `covel:onboardedVersion` are removed during boot by the settings cleanup path, so Playwright init scripts should seed `covel:settings` directly. Empty settings use the registry default for `ui.locale` (`zh-CN`), even when the browser context locale is `en-US`.
- `page.addInitScript()` runs on every new document, including `page.reload()`. Persistence tests that seed localStorage should guard with `if (!localStorage.getItem("covel:settings"))` before writing, otherwise reload overwrites the value being tested.
- `game-session.spec.ts` and `ai-world-gen.spec.ts` are live LLM e2e files. In web mode, `/api/provider-keys` intentionally returns raw keys as `{ keys: {} }` and exposes only masked availability in `providers`; treat any `providers.<id>.configured === true` as enough to run live LLM tests. In desktop bearer mode the same endpoint may return raw `keys`. In a no-key local environment these tests should report skipped tests instead of failing the whole Playwright suite.
- AI world generation uses a long non-streaming provider call. The server wraps that call with a finite timeout and should emit an SSE `error` event such as `LLM error: The operation was aborted due to timeout` instead of leaving the dialog in `generating` forever. Treat that as a live-provider failure, then validate the rest of the app with `full-flow`, `i18n`, and `game-session`.

## Browser Flow

Use Playwright for the real player path:

1. Open `http://localhost:5173/session`.
2. Seed onboarding state before navigation:

```js
await context.addInitScript(() => {
  localStorage.setItem(
    "covel:settings",
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      entries: {
        "ui.onboardedVersion": 3,
        "ui.locale": "zh-CN",
      },
    }),
  );
});
```

3. Pick the target world, for example `遥花学园`.
4. Verify the plugin selection screen:
   - world `recommendedPlugins` are enabled.
   - world `excludedPlugins` are disabled.
   - chat-mode worlds enable `chat-mode-narrator`, `scene-cast`, `scene-prompts`, `character-blueprint`, `character-presence`, `player-identity`, `living-world-rules`, and `branch-reply`.
5. Click `开始游戏`, then `开始冒险`.
6. Complete character creation when the form appears.
7. Play two or three turns through the composer or scene prompt options.
8. Capture screenshots under `output/playwright/`.

After `开始游戏`, inspect the right panel before the first narrative turn:

- `角色` tab already includes the world-imported NPCs and the player record after character creation.
- `蓝图` tab renders a compact imported-character list with one visible action area, readable labels, and no duplicated per-card send controls.
- The selected scene prompt is queued into the bottom composer; the composer remains the single send surface.

Minimal direct Playwright skeleton:

```js
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 980 },
});
await context.addInitScript(() => {
  localStorage.setItem(
    "covel:settings",
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      entries: { "ui.onboardedVersion": 3, "ui.locale": "zh-CN" },
    }),
  );
});
const page = await context.newPage();
await page.goto("http://localhost:5173/session", { waitUntil: "networkidle" });
await page.screenshot({
  path: "output/playwright/session.png",
  fullPage: true,
});
await browser.close();
```

## HTTP API Trace

Use HTTP checks to confirm the browser reached the expected backend state.

Session inventory:

```bash
curl -sS http://localhost:5173/api/worlds
curl -sS http://localhost:5173/api/plugins
curl -sS http://localhost:5173/api/framework/capabilities
curl -sS http://localhost:5173/api/sessions
curl -sS http://localhost:5173/api/sessions/<sessionId>
curl -sS http://localhost:5173/api/sessions/<sessionId>/plugins
```

State and plugin data:

```bash
curl -sS http://localhost:5173/api/sessions/<sessionId>/snapshot
curl -sS http://localhost:5173/api/sessions/<sessionId>/state
curl -sS http://localhost:5173/api/sessions/<sessionId>/characters
curl -sS http://localhost:5173/api/sessions/<sessionId>/plugin-data/character-blueprint/blueprints
curl -sS http://localhost:5173/api/sessions/<sessionId>/plugin-data/char-creator/characters
```

Turn execution:

```bash
curl -sS http://localhost:5173/api/sessions/<sessionId>/runtime-outputs?limit=20
curl -sS http://localhost:5173/api/sessions/<sessionId>/interaction-records?limit=20
curl -sS http://localhost:5173/api/traces/<sessionId>/turns
curl -sS http://localhost:5173/api/traces/<sessionId>
```

Frontend-equivalent message send uses `/api/actions` SSE:

```bash
curl -N -sS -X POST http://localhost:5173/api/actions \
  -H 'content-type: application/json' \
  --data '{"requestId":"manual-turn-1","type":"send_message","sessionId":"<sessionId>","locale":"zh-CN","payload":{"content":"我向神代澪道谢，然后询问放学后的社团楼参观安排。"}}'
```

For a healthy chat-mode turn, the SSE stream should include:

- `execution.started` with `runtimeCount > 0`
- one or more `runtime.started`
- one or more `runtime.completed`
- story output from `chat-mode-narrator`
- `plugin-data.changed` from scene prompts or branch reply when those plugins act
- `execution.completed` with `resultCount > 0`

## Database And Trace Expectations

The database truth for characters is the core `characters` table. Plugin panels can mirror that state into plugin data for UI convenience.

Character blueprint import should produce:

- `characters` table rows for instantiated NPCs.
- `plugin_data/character-blueprint:blueprints` rows keyed by blueprint id.
- `plugin_data/character-blueprint:characters` rows for blueprint-owned character mirrors.
- `plugin_data/char-creator:characters` rows for the shared character tab.

Creation-time hydration should produce:

- `GET /api/sessions/<sessionId>/snapshot` returns the world-imported NPCs in `characters`.
- The web `startGame` path reads that snapshot immediately after `POST /api/sessions`.
- The web path also hydrates `character-blueprint/blueprints`, `character-blueprint/characters`, and `char-creator/characters` through plugin-data APIs so the right panel is populated before any SSE event arrives.

Right-panel validation:

- `角色` tab reads session core characters and shows player + imported NPCs.
- `蓝图` tab shows compact blueprint cards with role, tags, persona, source, and linked character id.
- The database tab shows the same rows under `characters` and plugin namespaces.
- Screenshot review checks visual density: one compact list container for blueprints, no repeated primary action buttons inside each imported role.

Trace validation:

- `/api/traces/<sessionId>/turns` lists the tested turns.
- `/api/traces/<sessionId>/turns.discovery` includes framework capabilities, active plugin contracts, and plugin-data namespace/key indexes without plugin-data values.
- `/api/traces/<sessionId>` includes `runtime.started`, `runtime.completed`, `proposal.committed`, and LLM/tool events.
- Character creation or blueprint import includes `character.upserted`.
- `runtime-outputs` includes records for `scene-cast`, `chat-mode-narrator`, and `scene-prompts` after a normal chat-mode turn.

## Failure Triage

Use this order when the UI appears stuck:

1. `/api/sessions/<sessionId>`: inspect `turnCount`, `preGameCompleted`, and `activePlugins`.
2. `/api/sessions/<sessionId>/snapshot`: confirm messages, characters, plugin list, and execution steps.
3. `/api/sessions/<sessionId>/runtime-outputs?limit=20`: confirm runtimes produced output.
4. `/api/traces/<sessionId>`: find the last `runtime.started` without matching completion.
5. `/api/sessions/<sessionId>/interaction-records?limit=20`: confirm forms or choices were persisted.
6. Browser screenshot: verify the player-visible state matches the backend state.

When `/api/actions` returns `execution.completed` with `resultCount: 0`, debug the scheduler and trigger path before UI work. That means active plugins were loaded, while no runtime produced a committed result for that turn.
