# Deploy a trial on Render

When you finish this page, you will have a public Covel trial running on a Render free instance: anyone can open it, players play with their own API keys, and saves stay in each player's browser. For what players see and how their data and keys are handled, see [Play on a public trial](./hosted-trial.md).

Before you start, you need:

- A Render account.
- This repository, or your fork, on a Git host that Render can connect to.

## How it runs

`render.yaml` at the repository root is a Render Blueprint. It builds a free-plan web service, `covel-demo`, from `docker/Dockerfile`. Render rebuilds and redeploys it on every push to the connected branch.

This configuration runs the server in the browser-private form: `DEPLOYMENT_TIER=self`, `NODE_ENV=production`, `STORE_BACKEND=memory`. For the rules, see [Security boundaries](../internals/security.md#host-profile). In short:

- Any visitor can create sessions, generate worlds, list a provider's models and test their own keys.
- Opening a session takes the session token issued when it was created.
- Writing the shared world catalog, enabling a community plugin's server code, reading diagnostics, writing server settings and files, and cleaning up media all need the operator token (`COVEL_DESKTOP_REST_TOKEN`).
- The server does not check a request's `Host`, and does not let a model address point into the internal network.

The comment next to each variable in `render.yaml` says what it does.

## Steps

1. If you deploy from a fork, change the value of `COVEL_SOURCE_REPOSITORY` in `render.yaml` to your repository's address, and commit it. The source code link that players see in the notice comes from this value.
2. In the Render Dashboard, choose **New → Blueprint** and connect the repository. Render reads `render.yaml` and lists the service it will create, `covel-demo`. Confirm the creation.
3. Wait for the build and the deploy to finish. The service's log should show these two lines:

   ```text
   Starting server on 0.0.0.0:10000...
   Server running at http://0.0.0.0:10000
   ```

4. Open the service address (`https://<service-name>.onrender.com`). The notice "This is a public Covel trial" should appear at the top of the page.
5. Check the health endpoint:

   ```bash
   curl https://<service-name>.onrender.com/api/health
   ```

   The response should contain these entries (the commit is the one Render deployed this time):

   ```json
   {
     "operatorTokenRequired": true,
     "deployment": {
       "form": "browser-private",
       "source": {
         "repository": "https://github.com/ackness/covel",
         "commit": "<deployed commit>"
       }
     },
     "storage": {
       "data": {
         "backend": "memory",
         "durable": false,
         "frontendMode": "local"
       }
     }
   }
   ```

6. When you need to do operator work (such as writing shared worlds), copy the value of `COVEL_DESKTOP_REST_TOKEN` from **Environment** in the Render Dashboard, and enter it in the web app under **Settings → Operator Access**.

## Limits of the free instance

- **512 MB of memory.** The image runs the server as one Node process (`node --import tsx`), and `NODE_OPTIONS=--max-old-space-size=256` in `render.yaml` makes V8 reclaim memory before it reaches the container's limit. Started locally with the same settings, the idle process uses 240–330 MB.
- **It sleeps.** After 15 minutes without requests it goes to sleep, and the next visit takes about a minute to load. Sleeping, redeploying and crashing all clear the server's memory; for what is lost, see [Where your data lives](./hosted-trial.md#where-your-data-lives).
- **Memory only grows.** The server does not clean up idle session copies: every session that any player has opened stays in memory until the next restart. With many players, memory may grow to the limit, and the platform restarts the service.
- **The rate limit is shared.** Requests pass through Render's proxy, so the source address the server sees is the proxy's, and all players share the rate-limit quota of each route; with many players, some requests may get `429`. `TRUSTED_PROXY_IPS` accepts only exact IP addresses, so it cannot hold Render's proxy ranges.

## Do not do this

- **Do not give the operator token to players.** It passes the token check of any session.
- **Do not configure model keys on the server** (environment variables or `llm.toml`). Any visitor can create a session, and their sessions would call models with these keys.
- **Do not install community plugins.** A community plugin's server code has no sandbox, and it runs in the process that every player's keys pass through.
- **Do not set `COVEL_ALLOWED_HOSTS`.** The browser-private form runs no Host check, and the server refuses to start when it is set.
- **Do not turn on `ENABLE_DEBUG_PAGE`.** It lists every session on the server to visitors.

## When something fails

| Symptom                                                                     | What to do                                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Render says "No open ports detected"                                        | Check that `COVEL_BIND_HOST=0.0.0.0` and `SERVER_PORT=10000` have not been changed                                                  |
| After a deploy, the instance keeps restarting because it runs out of memory | Look in the log for what it was doing before each restart. If the free instance cannot hold it, move the service to a paid instance |
| The startup log says `COVEL_ALLOWED_HOSTS has no effect`                    | Remove this variable                                                                                                                |
| No trial notice at the top of the page                                      | Check with the `curl` above: `deployment.form` should be `browser-private`, and `storage.data.frontendMode` should be `local`       |
| The notice has no source code link                                          | Set `COVEL_SOURCE_REPOSITORY`; the value must be an `https://` address                                                              |
| The source code link in the notice has no version                           | When Render does not provide `RENDER_GIT_COMMIT`, put the commit in `COVEL_SOURCE_COMMIT`                                           |
| Players sometimes get `429`                                                 | The shared rate-limit quota is used up; try again in a minute                                                                       |
| The build fails                                                             | Find the first error in Render's build log. Locally, `docker build -f docker/Dockerfile .` reproduces it                            |
