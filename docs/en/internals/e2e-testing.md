# Browser End-to-End Testing

This page explains how to run the browser end-to-end tests (Playwright) locally, how to write a new spec, and which player flows to check by hand before a release. It is written for contributors who change the Covel source.

Automated tests run locally without Docker. PostgreSQL tests and the deployment relay acceptance procedure below use Docker.

## Quick Start

```bash
pnpm install
pnpm e2e
```

This runs all the Chromium specs under `tests/e2e/`. The default suite does not call a real model, so it costs nothing.

To run just one file or one test, pass the arguments straight to Playwright:

```bash
pnpm exec playwright test tests/e2e/game-session.spec.ts
pnpm exec playwright test tests/e2e/game-session.spec.ts --grep "restore"
pnpm exec playwright test --project=chromium tests/e2e/i18n.spec.ts
```

To debug step by step:

```bash
pnpm e2e:ui
pnpm exec playwright test --debug tests/e2e/game-session.spec.ts
```

`pnpm e2e:ui` opens the Playwright interface, and `--debug` runs a single spec step by step.

### How the Test Services Start

When `E2E_BASE_URL` is not set, Playwright starts its own isolated set of test services and shuts them all down when the run ends:

| Service         | Address                 | Notes                                                                                   |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| Server          | `http://127.0.0.1:3101` | Always uses a temporary MemoryStore                                                     |
| Built page      | `http://127.0.0.1:5183` | `apps/web/scripts/e2e-serve.mjs` builds into `dist/web-e2e` first, then serves the page |
| Vite dev server | `http://127.0.0.1:5181` | Serves the unbundled source modules                                                     |

- Both frontends proxy `/api/*` to port 3101.
- The tests do not reuse the 5173/3001 processes from `pnpm dev`, so old Vite caches and the local SQLite data cannot affect the results.
- Every run rebuilds, so frontend changes take effect directly, with no manual build.
- The test server uses its own temporary `COVEL_HOME`, user world directory and plugin directory, and these are cleaned up when the process ends. It does not read or change your `~/.covel`.

### Two Projects

The specs are split into two projects. The configuration sorts each file automatically, so you do not need to register anything by hand.

| Project        | Frontend               | Which specs                                                                       |
| -------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `chromium`     | Built page (5183)      | All the others                                                                    |
| `chromium-dev` | Vite dev server (5181) | Specs that load application source modules inside the page (`import("/src/...")`) |

- The built page is the version players actually run, and it loads much faster. The dev server is a single process that has to serve several hundred modules for each new browser context, so adding workers does not help; they still queue.
- The `expect` timeout for `chromium-dev` is 20 seconds, and for the others it is 5 seconds. The dev server transforms modules only when they are first requested, so first-screen time varies with machine load.
- To run only one project, use `--project=chromium` or `--project=chromium-dev`.

The built page carries a content security policy, and the dev server does not. `tests/e2e/page-policy.spec.ts` checks that the main pages, and a session with plugin panels, produce no policy violations. A new spec that wants the same check calls `watchPolicyViolations(page)` (`tests/e2e/helpers/page-policy.ts`) before the first navigation, and asserts at the end that the returned list is empty.

`tests/e2e/plugin-assets-isolation.spec.ts` checks classic page resources, the injected bridge and sandbox/CSP isolation under PAGE_CSP in `chromium-dev`.

### Accessibility Cases

```bash
pnpm e2e tests/e2e/catalog-accessibility.spec.ts
```

This case has Vite serve a synthetic test page directly. It uses the real component catalog and PluginPanel to check keyboard operation, label focus, duplicate IDs and the inert lock. It does not call a model or an API.

> [!NOTE]
> It belongs to `chromium-dev`. It cannot run against a production build that the server serves itself, and it is not part of the CI smoke tests. When you change the accessibility of the interface, run it yourself separately.

### Using a Service You Started Yourself

If you have already started the services, pass the **Vite** address in:

```bash
pnpm dev
E2E_BASE_URL=http://localhost:5173 pnpm e2e
```

After `E2E_BASE_URL` is set:

- Playwright no longer starts or shuts down any service, and both projects open this address. You are responsible for the services and the data directories.
- To run the full suite, the target server must use `STORE_BACKEND=memory`. Only a subset without browser-checkpoint cases can point to SQLite or PostgreSQL.
- When the target is a build that the server serves itself (a production or Docker environment with `SERVE_STATIC` set), the address can point directly to the server. In that case, `chromium-dev` specs cannot load the source modules, so run only the other group with `--project=chromium`.

### Running with a Real Model

The AI world generation interface flow is covered by `world-generation-progress.spec.ts`, which uses a fake model service and finishes in seconds (see [Model output without a real model](#model-output-without-a-real-model)).

To verify AI world generation and a three-turn game flow with a real model, you must turn it on explicitly. This makes model requests and costs money:

```bash
cp llm.toml.example llm.toml
cp .env.llm.example .env.llm
LIVE_LLM_ENABLED=1 pnpm e2e
```

## Writing a Spec: Shared Helpers

`tests/e2e/helpers/player.ts` provides the common actions and assertions for session specs. New specs use them directly, and do not copy their own versions.

A new spec runs on the built page by default. Write `import("/src/...")` only when the spec really needs to call application internal modules in the page. Such a spec is automatically assigned to `chromium-dev`, and it runs on the dev server, which is much slower.

| Helper                       | Purpose                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `composer` / `composerInput` | Locates the main input box (`data-testid`, not dependent on DOM order)                                  |
| `waitForTurnStarted`         | Waits for the asynchronous preparation before sending to finish, and confirms the turn has started      |
| `waitForTurnIdle`            | Waits for a started turn to really finish                                                               |
| `sendPlayerMessage`          | Types and sends a player message, and confirms the turn starts                                          |
| `expectPlayerCanAct`         | Asserts that after a turn ends, the player always has a usable action entry                             |
| `useServerWorlds`            | Lets specs that need state across pages or APIs explicitly use server worlds and the MemoryStore        |
| `seedAppSettings`            | Presets the onboarding version and the interface language, so the spec lands directly on the world list |

### How to Tell a Turn Has Ended

Finishing a click or input does not mean an asynchronous read or save has finished. Use Playwright locator assertions or `expect.poll` to wait for the final value; wait for persistence before reloading after a save. In React unit tests, use `findBy*` or `waitFor` for the actual result being asserted. Nearby content appearing does not mean a lazy component has mounted. Do not replace these conditions with fixed delays.

**Read `data-executing`. Do not infer it from `input:disabled`.**

- After clicking the button that starts a turn, first wait for `waitForTurnStarted`, and then wait for `waitForTurnIdle`. There is an asynchronous preparation step before sending. If the state has not yet switched to "executing", an assertion of `false` passes too early.
- While a turn is running, the input box is still enabled, because the player can interject. Using `toBeEnabled()` to decide that a turn has ended passes immediately, which means it waits for nothing.
- The input box is disabled only when there is a form or a choice that must be answered. These two states are shown by `data-executing` and `data-blocked` on the input area.

`expectPlayerCanAct` checks a rule that must not break: after a turn ends, as long as nothing required is on the screen, the main input box must accept free text. Suggestion panels such as action guides and quick replies for scenes are only shortcuts, and they must never lock the input box. If this regresses, the assertion fails directly.

### Where Worlds and Sessions Live

When the MemoryStore is used, the web app enters browser-private mode by default. World and session data live in the current browser's `BrowserVault`, do not appear in `/api/worlds`, and cannot be seen from another Playwright browser context.

- To reuse a world across later tests, or in direct API assertions in a serial spec, you must call `useServerWorlds(page)` before the first navigation, to explicitly switch to the server world directory and the temporary MemoryStore.
- When you verify only browser persistence behavior, complete it within the same page and context.

### All Specs Share One Server

During one run, all workers connect to the same server process and the same MemoryStore, all from the address `127.0.0.1`. When you write a spec, follow these rules. Otherwise it can pass when run alone and fail occasionally when the whole suite runs:

- **Do not assume the server is empty.** A spec that calls `useServerWorlds` can see sessions created by other specs, including those running in parallel. World cards get an extra "Resume" button, and the session prep screen lists existing sessions. Create your own session, operate on it by its ID, and delete it in `finally`.
- **The page draws first, and the data arrives later.** After `goto` / `reload`, the command list, the session list and the plugin data each arrive asynchronously, and the intermediate states really exist. First use assertions that retry to wait for the final state (for example `toHaveCount(1)`), and only then assert on a single element. A strict-mode error for matching several elements is not retried, and it fails immediately.
- **The per-IP rate limit is shared across the whole suite.** The default configuration raises the test server's `RATE_LIMIT_RPM`, but fixed quotas still apply (for example, `/api/actions` allows 30 calls per minute). A spec that does not need a real turn uses `page.route` to block `**/api/actions`.
- **Failure screenshots are taken after `finally`.** If `finally` deleted the session or navigated to a blank page, the screenshot and page snapshot show "Reconnecting…" or a white screen, not the page as it was when the test failed. Rely on the error message and the call log, and use `--trace on` when you need the live state.

When you suspect a spec is unstable, first run it repeatedly on its own, and then run it together with the rest:

```bash
pnpm e2e tests/e2e/reasoning-display.spec.ts --repeat-each=20 --workers=1
```

### Model Output Without a Real Model

A spec that needs model output, but must not access a real model service, uses `tests/e2e/helpers/fake-llm-provider.ts`. `startFakeLlmProvider()` starts an OpenAI-compatible fake service inside the test process, listening on a random port on `127.0.0.1`:

- `provider.reply = (request) => ({ text, ... })` decides the answer for each request.
- `streamMs` spreads the answer evenly over a period of time.
- `stall` sends the first part and then stops producing output.
- `hold` keeps the answer stopped before its last part until the test lets it continue. Use it to assert the page state while a request is halfway through, without relying on timing.
- `provider.requests` records the requests received, in order.

For how to point the page's requests at it, see `useFakeModel` in `world-generation-progress.spec.ts`. It uses `page.route` to add `X-Slot-Config` (a custom model config whose `baseUrl` points to the fake service) and `X-Provider-Keys`, and it changes the `model` in the request body to the ID of this config. The page, the server routes, the gateway and the HTTP adapter are all real. Only the model service is fake.

> [!TIP]
> Do not verify timeouts with real waiting. The wait time is a request parameter: the world-creation endpoint's `idleTimeoutMs` can be as small as 1000. With `stall`, one second or so is enough to reach a conclusion. With `streamMs: 2500`, you can prove that "output lasting longer than the no-response timeout still completes". What you verify is these properties, and it has nothing to do with the default 120 seconds.

The world generation case delays the response of the health check before the first generation, and it asserts that the request uses `saveTarget: "return-only"`. Each browser context saves its results separately, so worlds with the same name are not written into the shared server directory, where they could affect later cases or retries.

## Plugin Pipeline Verification

To verify how a plugin behaves across a complete turn, rather than on the page, use a script that drives the HTTP API. It needs a running server and a real model:

```bash
pnpm e2e:verify
```

Common arguments:

```bash
# Pick a slot from llm.toml
pnpm e2e:verify --slot e2e_local --turns 5

# Focus on a single plugin
pnpm e2e:verify --plugin guide --turns 2
```

For the full arguments and the output format, see [Verify with a real model](../ship/real-model.md).

`tests/llm-replay/` holds scripted sessions. Recording one calls a model (about 4 minutes for three turns); replaying it calls none and plays a full game in seconds. Recordings stay on your machine and are not committed. Use them to confirm that a refactor did not change the requests sent to the model: record on `main` before the change, replay after it:

```bash
pnpm e2e:replay --record lantern-barrow   # before; needs DEFAULT_BASE_URL and DEFAULT_API_KEY
pnpm e2e:replay                           # after
```

For the arguments and the details of recording, see [Recording and replay](../ship/real-model.md#recording-and-replay).

## Environment Variables

| Variable                | Default                                                                              | Notes                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `E2E_BASE_URL`          | For `chromium`, `http://127.0.0.1:5183`; for `chromium-dev`, `http://127.0.0.1:5181` | The address Playwright navigates pages to. When set, it means you use an external environment you manage yourself |
| `E2E_MODEL_SLOT`        | Not set (follows the configured model routing)                                       | The slot that `pnpm e2e:verify` makes story runtimes use. Same as `--slot`                                        |
| `LIVE_LLM_ENABLED`      | `false`                                                                              | Explicitly turns on Playwright/Vitest flows that access a real model service                                      |
| `COVEL_STORY_BASE_URL`  | Not read by any code                                                                 | Does not override a slot; the proxy address is written directly into `llm.toml`                                   |
| `COVEL_PLUGIN_BASE_URL` | Not read by any code                                                                 | Does not override a slot; the proxy address is written directly into `llm.toml`                                   |
| `CI`                    | `false`                                                                              | In CI mode, Playwright retries twice, uses only one worker, and forbids `test.only`                               |

## PostgreSQL Mode

To run the local service with the PostgreSQL backend, start the database first:

```bash
pnpm db:up
pnpm dev:pg
E2E_BASE_URL=http://localhost:5173 pnpm e2e
```

In this case, exclude the specs that support only MemoryStore (see [Using a service you started yourself](#using-a-service-you-started-yourself)).

To clean up the database container:

```bash
pnpm docker:pg:down
```

## Where Output Goes

| Path                  | Contents                                                     |
| --------------------- | ------------------------------------------------------------ |
| `tests/e2e/artifacts` | Playwright traces, videos and other artifacts                |
| `tests/e2e/report`    | HTML report                                                  |
| `debugs/e2e-logs`     | Logs and JSON artifacts from the plugin verification scripts |

These directories are excluded in `.dockerignore`, so they do not enter the production image context.

## Player-Flow Acceptance Before a Release

Passing automated tests does not mean the game is playable. Before a release, go through the following in order.

1. Run `pnpm lint`, `pnpm test` and `pnpm e2e` locally, in sequence. Do not run them at the same time, because they share the build directory.
2. Run `pnpm release:preflight`.
3. Fix the failures you already know about locally before you push. Use remote CI to double-check, and to cover platform differences such as Windows and macOS.

Rules for version numbers:

- The framework's release tag must match the package versions in the root, `apps/` and `packages/`. Plugins and world packs can keep their own versions.
- The preload of the web app and the desktop app reads the version from the application package. Do not write a separate version constant in translation or runtime code.

When a change affects play or the plugin lifecycle, also go through the player flow in an isolated data directory, using a formal build and a real model:

- From choosing a world and configuring a model, to submitting a character. After invalid input is rejected, you can still edit it and continue.
- Play several turns in a row, and check the story text, quick replies, the sidebar and free text input. Check both the desktop and narrow-screen layouts.
- After an interruption, a failure, a refresh or a retry, you can still keep going. Completed story steps are not submitted twice, and the turn count does not increase twice.
- After saving and restarting, characters, story, plugin data and settings are all restored, and you can complete one more turn.
- Install a third-party plugin from a ZIP with its own ID, and verify authorization, denial, duplicate install, enabling, uninstalling and reinstalling. Confirm that existing saves can still be used, and that deterministic settlements are not run again because of a retry or a restart.

Record the results at the end: the model actually used, the build version, the result of each flow, and the boundaries that were not covered.

> [!IMPORTANT]
> A real-model case skipped in the default E2E run does not count as real-model verification. An API that returns success is not a substitute for going through the whole flow on the page. After release, download the artifacts and check the version, the resources and the startup result.

For the full release steps, see the [release checklist](./desktop-packaging.md#release-checklist).

## Accepting Local Model Relay on Desktop and Deployed Web

Use this procedure to retest a deployed Covel instance calling a model on the player's computer. A successful connection test is only the first step: character creation, narration, and default plugins must actually run. Use separate test saves; model calls incur usage charges.

### Prepare the Environments

1. Record the tested commit and build version. Build the production desktop artifact following [desktop packaging](./desktop-packaging.md), and start it with an isolated test data directory.
2. Build the web deployment from `docker/Dockerfile` with the settings in `render.yaml`, especially `NODE_ENV=production`, `STORE_BACKEND=memory`, `DEPLOYMENT_TIER=self`, and static page serving. Apply the same memory limit and publish the port only on host loopback. Keep a permission-restricted temporary environment file outside the repository; do not mount personal configuration directories.
3. Open the page and verify `/api/health` reports `browser-private`, `modelRelay: true`, `memory`, and frontend `local`. Desktop should report `personal` and does not need browser relay.
4. Start the local model gateway. In Covel settings, choose the actual protocol, Base URL, and model, and bind every needed purpose, including story, plugin, and memory. Enter credentials only in settings. For Magpie origin permission and gateway keys, see [Magpie browser setup](../start/hosted-trial.md#magpie).
5. Test model listing and the connection separately. Verify the same loopback port is unreachable inside the container but reachable from the browser; host networking or a proxy must not bypass the relay.

Local Docker verifies the deployment configuration and whose loopback address is used. It does not replace checks for browser permissions, certificates, reverse proxies, and cold starts on the live HTTPS site. Test those separately after the deployed version updates.

### Play and Restart

1. Create a new world session and wait for the plugin plan to load. Keep the world's default pack and check that automatically added dependencies remain enabled. Manually enabling dependencies first does not count as passing the default flow.
2. Start the adventure and complete setup forms and character creation. Expand the "Execution · N runtimes" row below the story and check for model configuration errors, missing dependencies, or failed tasks.
3. Wait for opening narration and plugin settlement. Complete at least two player turns: one quick reply and one free-text message. Have the story explicitly change a quest or item, then check its panel, character state, and turn record. HTTP 200 and a successful tool call do not prove persistence.
4. From browser network traffic, extract only model request paths, status codes, and destination addresses. Actual model requests should reach the player's loopback address. Cover ordinary generation, streamed narration, and model calls from function plugins. Do not export a HAR containing request headers.
5. Wait for settlement, restart the Docker container, and reopen the same save. Verify story, characters, plugin selection, and data are restored, then complete a third player turn. For desktop, quit and relaunch the same production artifact with the same test data directory.
6. Check failure recovery separately: invalid test credentials should produce an authentication error; an unapproved origin should produce a browser access failure. Correct the configuration and retry without duplicate story commits or turn increments. Do not change existing user credentials or revoke existing permissions for this test.

### Save Reusable Results

Record only the commit, app and browser versions, model protocol and name, anonymous test scenario, pass/fail, error categories, and coverage gaps. Use `<test-data-dir>` for personal absolute paths, `<test-origin>` for origins, and `<gateway-key>` for credentials; do not save their real replacements.

Do not record keys, tokens, authentication headers, environment file contents, browser storage exports, or screenshots containing them. Before sharing logs or screenshots, remove personal paths, account information, and real session identifiers. Keep raw debug artifacts in ignored `debugs/`; do not upload them with documentation or a PR.

<!-- prettier-ignore -->
| Check | Pass criteria |
| --- | --- |
| Production desktop artifact | Setup, two turns, and a third turn after restart complete |
| Docker deployment profile | Correct health response; container cannot reach the player's loopback port |
| Browser relay | Real gameplay requests reach the player's machine; streaming works |
| Default plugins | Dependencies remain enabled, tasks succeed, and panel data survives restoration |
| Failure recovery | Recognizable errors, successful retry after correction, no duplicate commits |
| Live site follow-up | HTTPS, permissions, proxy, and cold-start results recorded separately |
| Evidence privacy | No personal paths, keys, tokens, or request headers |

### Screenshots and README updates

1. Capture real acceptance saves using fictional character details. Emberback works for text play and Harukaze Academy for stage play. Complete a player turn and confirm that default plugins settle successfully first.
2. Use a consistent output of **1600 × 1000 pixels, 100% zoom, device scale 1**. Use the dark **Panel** scheme for feature images. Each README uses its matching UI and content language. Content language is fixed when a session is created, so English captures need an English save, not just English labels over a Chinese save. Exclude browser chrome, native window borders, extension overlays, and the session's "Jump to latest" button.
3. Take story and dice captures from the same save within each language, but give each image a distinct focus: for example, narration with the quest log, and checks or item actions with inventory. Stage images show actual backgrounds, sprites, and fully revealed dialogue.
4. Wait for models, fonts, images, and transitions before capturing. Frame through normal navigation, panel selection, folding, and scrolling; do not rewrite the DOM, story, or execution status to manufacture success. A narration capture may use a taller viewport and the browser's native screenshot clipping to frame the content; keep the main subject complete and readable, exclude tooltips and temporary menus, and record the actual viewport and clipping rectangle.
5. Select distinctive images for the README, each showing a different product capability. Omit empty forms, ordinary lists, and repeated views; keep other captures as local acceptance evidence. Replace the selected images under `.assets/images/readme/`, remove unreferenced old images, and update references, alt text, and descriptions in both READMEs. Keep each PNG below 3 MiB. Inspect dimensions, legibility, framing, and privacy for every image, then run documentation checks. Keep the demo GIF at the top of the README; when it clearly no longer matches the current UI, re-record it following the [contributing guide](../../CONTRIBUTING.en.md#showcase-site-demo-media) instead of replacing it with a still.

Record the capture's commit, scene, turn, theme, and viewport. If an image includes a key, personal path, or account detail, reframe it and do not commit the original.

## Troubleshooting

| Symptom                                                  | What to do                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Port already in use, or the page does not open           | The default test Vite is `5181`, the built page is `5183`, and the API is `3101`. Vite has `strictPort` enabled, so it will not quietly switch to another port. Stop the process that holds the port and try again. To use a page you started yourself, set `E2E_BASE_URL`, and make sure the backend type matches the target spec.        |
| Waiting for the API health check times out               | The default run checks `http://127.0.0.1:3101/api/health`. For an external environment, check the server address it actually uses. For the PostgreSQL flow, run `pnpm db:up` and `pnpm dev:pg` first, then point `E2E_BASE_URL` at the matching page, and exclude the specs that support only MemoryStore.                                 |
| A model call or character creation fails                 | The real-model specs in the browser use the model roles configured in the app, such as `story` and `plugin`. `pnpm e2e:verify` also routes by configuration, and it switches to a specified slot only when `--slot` is passed or `E2E_MODEL_SLOT` is set. Confirm that the slots you need exist, and that `.env.llm` has the matching key. |
| You need to locate an asynchronous failure               | On failure, Playwright keeps screenshots. Traces and videos are kept only on the first retry. Open the HTML report with `pnpm exec playwright show-report tests/e2e/report`.                                                                                                                                                               |
| Cannot find the output of the plugin verification script | The script writes to `debugs/e2e-logs/` by default. Pass `--no-log` if you only want to see it in the terminal, and `--keep` to keep sessions and snapshots.                                                                                                                                                                               |
