# Principles and maintenance

This chapter is for people who want to change the framework itself, or who want to find out which layer a problem is in. You do not need to read this chapter to use Covel, build a world, or build a plugin.

## How it works

| Page                                        | Question it answers                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| [Design principles](./design-principles.md) | What belongs in the kernel, and what is left to plugins                         |
| [Turn pipeline and data flow](./flow.md)    | How a turn goes through trigger, scheduling, execution, and commit              |
| [Package responsibilities](./packages.md)   | What each package in the repository is responsible for, and who depends on whom |
| [Storage](./storage.md)                     | The three storage backends, browser saves, and who owns the data                |
| [Security boundaries](./security.md)        | Outbound requests, keys, deployment tiers, and trust in community plugins       |
| [NPC relationship graph](./npc-graph.md)    | How the relationship graph plugin stores and retrieves character relationships  |
| [Known limits](./technical-debt.md)         | Limits we keep on purpose, and when they should be upgraded                     |

## Contributing

| Page                                         | Contents                                                         |
| -------------------------------------------- | ---------------------------------------------------------------- |
| [Contributing guide](../../CONTRIBUTING.md)  | Branches, commits, checks, and the release process               |
| [Commands](./commands.md)                    | Less common scripts, Git hooks, and the scope of CI              |
| [Browser end-to-end tests](./e2e-testing.md) | Playwright tests and the player-flow acceptance before a release |
| [Desktop packaging](./desktop-packaging.md)  | Local builds, signing, and the release checklist                 |
| [Skills for development agents](./skills.md) | The skills that come with the repository, and how to write one   |
| [v0.0.42 upgrade guide](./upgrade-0.0.42.md) | What to do when upgrading from a version before v0.0.42          |
| [Changelog](../../CHANGELOG.md)              | Changes in each version, breaking changes, and upgrade notes     |

## Where to start reading

When you want to change the framework, read in this order:

1. [Design principles](./design-principles.md). First confirm whether what you want to add belongs to the kernel or to a plugin. Most gameplay needs belong to plugins.
2. [Turn pipeline and data flow](./flow.md). Find the stage of the pipeline where your change falls.
3. `AGENTS.md` in the repository root. It lists the documents that each kind of change must update, and the checks to run.
