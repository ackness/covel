# Play on a public trial

This page is for players who play Covel on a public trial. A trial is a Covel web app that someone has deployed on a cloud server and that anyone can open; the Covel project's own trial is at [demo.covel.cc](https://demo.covel.cc/). When you finish reading, you will know where your saves and API keys are kept, what the server can see, what a trial loses, and how to check these claims.

If you use the desktop app, or a web app you deployed for your own use, your data goes elsewhere; see [Data, backup and upgrades](./data-and-upgrade.md).

## How to recognize a trial

A trial shows a notice at the top of the page: "This is a public Covel trial". The notice has two links: one, "How your data and keys are handled", leads to this page; the other leads to the version of the source code the site is running (present only when the operator configured the source address).

After you dismiss the notice, it no longer appears in this browser. In **Settings → LLM → Providers & Models**, the place where you enter each provider's key still links to this page.

## Where your data lives

On a trial, your browser holds the copy of your saves that counts. The server keeps only the temporary copies it needs to run turns, in memory, and writes nothing to a database or to disk.

| Data                                                                | Where it is kept                               | When it is lost                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Saves: game state, conversation, characters, plugin data, snapshots | Your browser (IndexedDB)                       | When you clear this site's data in your browser. Another browser, another device or a private window does not see it either |
| Worlds you created or generated                                     | Your browser (IndexedDB)                       | Same as above                                                                                                               |
| API keys and settings                                               | Your browser (localStorage)                    | Same as above                                                                                                               |
| The copy of your save used to run turns                             | Server memory                                  | When the server restarts. The next action uploads it again, and your save is not affected                                   |
| Generated images and other media                                    | Server memory; the save keeps only a reference | When the server restarts. The browser may still hold a cached copy for display, but this is not guaranteed                  |
| The search index of long-term memory                                | Server memory                                  | When the server restarts. It is rebuilt on the next action, which calls the embedding model again                           |
| Progress of background jobs that have not finished                  | Server memory                                  | When the server restarts before the job finishes. The browser saves once more after the job finishes                        |

The server does restart: every deploy of a new version restarts it. A trial on a Render free instance goes to sleep after 15 minutes without visitors. Sleeping counts as a restart, and the first visit after it takes about a minute to load.

A session's save is at most 64 MiB. The page warns you when it gets close to that; then carry the story on in a new session.

A trial cannot export or import a full save yet. Do not keep important progress here; to play for the long term, use the [desktop app](./install.md).

## How your API keys are used

1. The keys you enter in settings are stored in plain text in this browser's local storage.
2. When a model needs to be called, the browser puts the keys of the providers this request needs in a request header and sends them to the server over HTTPS. Right after the page opens, before it has read the server's model configuration, it sends all the saved keys.
3. The server uses the key to call the model provider you configured, and only within this request.
4. A background job that keeps running after the turn ends holds this request's model configuration, including the key, in server memory. Only this job of this session uses it: it is dropped when the job starts, when the session is deleted, or after 5 minutes.
5. The server never writes a key to disk, a database, a save or a log. The request log records only the method, the path and the status code of each request.

### Who can get your keys

| Who                                       | Can they get it | Why                                                                                                                                                                                                                                                          |
| ----------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Other players                             | No              | A key belongs only to the request that sent it, and the server has no shared key table. They cannot open your session either: opening a session takes the token issued when it was created                                                                   |
| Other people on the network               | No              | The trial uses HTTPS                                                                                                                                                                                                                                         |
| Plugin authors                            | No              | A community plugin's server code needs the operator token to be enabled; a trial deployed with the project's own Render configuration has only the bundled plugins that ship with the source code. A plugin also cannot decide where model requests are sent |
| Other websites                            | No              | The browser's same-origin rule keeps them apart. The page has a Content Security Policy (CSP), and plugin web pages run in isolated frames that cannot read local storage                                                                                    |
| The trial's operator                      | Yes             | A key has to pass through the server to call a model. An operator who changes the deployment can record it, and you cannot confirm from outside that they do not                                                                                             |
| The hosting platform (for example Render) | In theory       | HTTPS is decrypted at the platform's proxy                                                                                                                                                                                                                   |
| Anyone who can use your computer          | Yes             | The key is stored in plain text in the browser                                                                                                                                                                                                               |

We do our best to protect your data, but the key still has to pass through the server. So please:

- Create a temporary key just for the trial, with a spending limit, not your main key. The trial's notice, the model step of the guide and each provider's key form remind you of this.
- When you finish, delete or rotate that key in the provider's console. Deleting it in Settings only stops this browser from keeping it; the key itself still works.
- After playing on a public computer, clear this site's data in the browser.

## Use a model on your own computer or local network

The trial's server cannot reach your computer or your local network. So when a model address is on your computer or local network (a local model server such as Ollama, LM Studio or Magpie), your browser relays those requests. This is called the local model relay: the server hands the request to your browser, the browser sends it to your model server, and then passes the answer back to the server. Model addresses on the public internet do not go through the browser; the server still requests them directly.

### How to set it up

1. In **Settings → LLM → Providers & Models**, add a provider and enter the address on your computer, for example `http://127.0.0.1:3425/v1` or `http://localhost:11434/v1`. A service on your local network needs an HTTPS address, for example `https://192.168.1.20/v1`. A note under the address says that your browser relays it.
2. Let the model server accept cross-origin requests from the trial. The browser requests your model server directly, so the model server must allow the trial's address as an origin in its answers (CORS); otherwise the browser blocks the answer. On demo.covel.cc that is `https://demo.covel.cc`, and the note under the address names the current trial's address too. For Ollama, for example, set the environment variable `OLLAMA_ORIGINS` to that address and restart Ollama. For other servers, look for CORS or "allowed origins" in their settings.
3. Start a game as usual, and keep the page open while you play. The first time the browser reaches your device or local network, it may ask whether this site may access it; allow it.

### Limits

- A plain http address on your local network (for example `http://192.168.1.20:8000`) does not work: browsers do not let an HTTPS page reach it. Give it HTTPS, or forward it on this computer through `127.0.0.1`.
- When you close the page or the network drops, relaying stops, and background jobs that have not finished fail. Once the page reconnects, the next action works as usual.
- For an address on this computer, write `127.0.0.1` or `localhost`, not `[::1]`.
- Requests that upload a file (for example image editing) cannot be relayed.
- The requests and answers still pass through the trial's server, just as with a model on the public internet.

### What the browser does for the server

- The browser requests only the addresses you added in Settings: the same scheme, host and port, and under the same path. It refuses any other address the server asks for, and sends no request.
- It uses only GET and POST, sends no cookies and follows no redirects.
- Within this scope, the trial can send whatever requests it needs, just as a server holding an API key can call that provider's API. So write the address down to the actual API path (for example `http://localhost:11434/v1`), not just the port: that keeps the model server's admin API (for example Ollama's API for pulling or deleting models) out of the relay's reach.
- The channel ID used for relaying is kept only in this page, and goes to the server only with this page's own requests. Other visitors cannot get it, so they cannot use your browser to reach your computer.

For the full rules, see [Security boundaries](../internals/security.md#local-model-relay).

## How to check

- Covel's code is fully open source. The source code link in the trial's notice points to the commit it is running. The deployment platform provides the version (Render's `RENDER_GIT_COMMIT`).
- When the trial is deployed with the project's own Render configuration, Render builds it automatically from the public repository and redeploys it on every push. For the steps, see [Deploy a trial on Render](./deploy-render.md).
- The version tells you which code the trial claims to run. It cannot prove that the deployment has not been changed; you still have to trust the operator.
- Where these rules come from in the code: [Security boundaries](../internals/security.md#host-profile) and [Storage](../internals/storage.md#browser-private-protocol).

## When something goes wrong

| Symptom                                                                                | Cause and what to do                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The first visit takes about a minute                                                   | The free instance is starting after sleeping. Wait for it to start, then refresh                                                                                                                                         |
| Images generated earlier are gone                                                      | The server restarted, and the images were only in server memory. The save itself is not lost                                                                                                                             |
| Saves are gone after switching browser or device                                       | Saves exist only in the browser you used before                                                                                                                                                                          |
| A warning says the save is near the browser's size limit                               | A session's save is at most 64 MiB. Carry on in a new session                                                                                                                                                            |
| No trial notice at the top of the page                                                 | You dismissed it, or this is not a trial. Where you enter keys in **Settings → LLM → Providers & Models**, there is still a link to this page                                                                            |
| An admin action asks for the operator token                                            | The trial keeps the shared world catalog, community plugins, diagnostics and server settings for the operator                                                                                                            |
| A local model reports "no relay was connected for this request"                        | The page has just opened and is not connected yet, or the network dropped. Keep the page open, wait a few seconds and try again                                                                                          |
| A local model reports "your browser could not reach …"                                 | The model server is not running, or it does not accept cross-origin requests from the trial (see step 2 of [How to set it up](#how-to-set-it-up)), or the browser was not allowed to access your device or local network |
| A local model reports "browsers do not let an HTTPS page reach a plain-http address …" | The local network address uses plain http; see [Limits](#limits)                                                                                                                                                         |
| A local model reports "this browser relays only to the model endpoints you added …"    | The address the server asked for is outside the addresses you added. Check that the address in Settings is right                                                                                                         |
