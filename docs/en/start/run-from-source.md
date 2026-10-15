# Run from Source

Run from source to change the framework or develop worlds and plugins in the repository. You can also use it if your system has no installer package. When you are done, the browser opens the same interface as the desktop app.

## Before you start

- [Git](https://git-scm.com/).
- Node.js and pnpm. The versions are set in `mise.toml` at the root of the repository. If you have [mise](https://mise.jdx.dev/) installed, run `mise install` inside the repository to get the right versions.

## 1. Get the code and install the dependencies

```bash
git clone https://github.com/ackness/covel.git
cd covel
pnpm install --frozen-lockfile
```

## 2. Start

```bash
pnpm dev
```

This starts the web app (port 5173) and the backend (port 3001) together. Open <http://localhost:5173>, and you will see the world selection page.

Saved games are written to the SQLite database on your computer. To stop, press `Ctrl+C`. If a process is left running, run `pnpm stop`.

## 3. Connect a model

The simplest way is the same as in the desktop app. In the interface, go to **Settings → LLM → Providers & Models**, add a provider, and enter your key. See [Connect a model](./models.md). These settings are saved in the current browser.

If you want to keep the model setup in files (for example, one shared by a team), copy three example files:

```bash
cp .env.example .env              # backend and storage settings
cp llm.toml.example llm.toml      # model roles and endpoints
cp .env.llm.example .env.llm      # provider API keys
```

Do not commit these three files to the repository. Choices made in the interface take priority over `llm.toml`, and they are not written back to the file.

## Differences from the desktop app

|                             | Desktop app             | Run from source                                                       |
| --------------------------- | ----------------------- | --------------------------------------------------------------------- |
| Interface settings and keys | Files under `~/.covel/` | The current browser's local storage                                   |
| Your worlds                 | `~/.covel/data/worlds/` | `~/.covel/worlds/` (you can change it with `COVEL_USER_WORLDS_DIR`)   |
| Your plugins                | `~/.covel/plugins/`     | `~/.covel/plugins/` (you can change it with `COVEL_USER_PLUGINS_DIR`) |
| Built-in worlds and plugins | Packaged inside the app | The repository's `worlds/` and `plugins/`                             |

## Common commands

| Command           | What it does                              |
| ----------------- | ----------------------------------------- |
| `pnpm dev`        | Starts the web app and the backend        |
| `pnpm dev:server` | Starts only the backend                   |
| `pnpm dev:web`    | Starts only the web app                   |
| `pnpm stop`       | Ends leftover development processes       |
| `pnpm check`      | Static checks, the same gate that CI uses |
| `pnpm test`       | Runs all unit tests                       |

The Debugger page is at <http://localhost:5173/debug>. It shows each plugin's model requests, tool calls, and timing for every turn.

## Troubleshooting

| Symptom                                           | What to do                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm install` reports a version mismatch         | Run `mise install` to install the Node.js and pnpm versions that `mise.toml` specifies              |
| On startup, a message says the database is in use | Another Covel process (for example, the desktop app) is using the same database file. Quit it first |
| The port is already in use                        | Run `pnpm stop`, or change `SERVER_PORT` in `.env`                                                  |

## Learn more

- [All environment variables](../reference/env-registry.md)
- [Less common commands](../internals/commands.md)
- [Contributing guide](../../CONTRIBUTING.md)

## Next steps

- [Your first world](../worlds/first-world.md)
- [Your first plugin](../plugins/first-plugin.md)
