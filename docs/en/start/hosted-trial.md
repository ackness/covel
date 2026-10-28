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

So we suggest that you:

- Use a separate key with a spending limit, not your main key.
- When you stop playing, delete the key in settings, or revoke it in the provider's console.
- After playing on a public computer, clear this site's data in the browser.

## How to check

- Covel's code is fully open source. The source code link in the trial's notice points to the commit it is running. The deployment platform provides the version (Render's `RENDER_GIT_COMMIT`).
- When the trial is deployed with the project's own Render configuration, Render builds it automatically from the public repository and redeploys it on every push. For the steps, see [Deploy a trial on Render](./deploy-render.md).
- The version tells you which code the trial claims to run. It cannot prove that the deployment has not been changed; you still have to trust the operator.
- Where these rules come from in the code: [Security boundaries](../internals/security.md#host-profile) and [Storage](../internals/storage.md#browser-private-protocol).

## When something goes wrong

| Symptom                                                  | Cause and what to do                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The first visit takes about a minute                     | The free instance is starting after sleeping. Wait for it to start, then refresh                                                              |
| Images generated earlier are gone                        | The server restarted, and the images were only in server memory. The save itself is not lost                                                  |
| Saves are gone after switching browser or device         | Saves exist only in the browser you used before                                                                                               |
| A warning says the save is near the browser's size limit | A session's save is at most 64 MiB. Carry on in a new session                                                                                 |
| No trial notice at the top of the page                   | You dismissed it, or this is not a trial. Where you enter keys in **Settings → LLM → Providers & Models**, there is still a link to this page |
| An admin action asks for the operator token              | The trial keeps the shared world catalog, community plugins, diagnostics and server settings for the operator                                 |
