# What Is Covel

Covel is an AI RPG you can play right away, and it is also a framework for building games like it. You enter an action, and the model writes what happens next. Quests, inventory, affinity, and memory are updated and saved each turn.

This page takes five minutes to explain what it is made of. When you finish it, you will know which chapter to read next.

## Three layers: kernel, plugins, and world packages

Covel splits a game into three layers, and each one handles its own job:

| Layer             | What it handles                                                   | Examples                                                                    |
| ----------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **World package** | Setting and content: what kind of world this is                   | Worldview, characters, rules, opening quests, portraits, and scene pictures |
| **Plugin**        | Behavior: how the game is played                                  | Narrator, dice checks, quest log, inventory, affinity, memory               |
| **Kernel**        | General rules: what runs first, and what can be written to a save | Schedules the run order, checks changes, saves, and shows the interface     |

To remember it in one sentence: **the world describes the content, plugins implement the behavior, and the kernel provides the general interfaces and execution rules.**

This boundary brings three direct benefits:

- The same world can use a different narrator, or leave the quest system off, without changing any code.
- The same plugin can be used in many worlds, and it does not need to know which world it is in.
- Your worlds and plugins are separate packages, so you can send them to others to install on their own.

## What happens in one turn

After you send an action:

1. The kernel decides which plugins run in this turn, and puts them in order by stage: before the narrative, the narrative, after the narrative, and the final check.
2. Each plugin reads what it needs, such as the world setting, the recent conversation, and the data it saved itself.
3. The narrator plugin writes the story text, and you watch it appear on the screen one character at a time.
4. After the narrative, other plugins update their own states based on that text: whether a quest moved forward, what was added to your inventory, and whose attitude toward you changed.
5. The kernel checks all the changes and writes them to the save in one go. The interface shows "Turn complete".

Plugins cannot change the save directly. They can only propose "I want to change this", and the kernel really writes it only after the check passes. So a turn either takes full effect, or leaves nothing behind.

## Two ways to view the story

![Stage mode: scene background, character portraits, and dialogue box](/stage-mode.webp)

- **Stage mode** is a full-screen visual novel: scene background, character portraits, a typewriter-style dialogue box, and choices.
- **Text mode** is a classic text-based turn: the story text includes action suggestions and forms, and you can expand each turn to see what every plugin did.

![Text mode: story text, action suggestions, and the right-hand panel](/text-mode.webp)

A world can set its default story view, and you can switch views at any time during the game.

## What you need

- **A computer**: macOS (Apple Silicon, macOS 13 or later) or Windows x64.
- **A model**: Covel does not include a model. You need an API key from a provider, or a locally running model service that is compatible with the OpenAI interface. The model must support tool calls.

Covel is in early access. The manifest format, world data, and API may change between versions. Before you upgrade, read [Data, backup, and upgrading](./data-and-upgrade.md).

## What to read next

| What you want to do                 | Start here                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| Start playing right away            | [Install and first launch](./install.md)                                              |
| Write a world of your own           | [What a world package is](../worlds/index.md)                                         |
| Add a gameplay feature or interface | [What a plugin is](../plugins/index.md)                                               |
| Change the framework itself         | [Run from source](./run-from-source.md), then read [Internals](../internals/index.md) |
