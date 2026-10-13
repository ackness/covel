# Verify and distribute

Your plugin or world works on your own computer. This chapter helps you answer the next question: **will it still work when other people install it?**

## Do these in order

| Step     | What to do                                              | Read this page                              |
| -------- | ------------------------------------------------------- | ------------------------------------------- |
| 1        | Test the plugin without starting the game first         | [Test your plugin](./test.md)               |
| 2        | Package it, and install it once as a stranger would     | [Package and try an install](./package.md)  |
| Optional | Run a full pass with a real model                       | [Verify with a real model](./real-model.md) |
| 3        | Put it on GitHub so others can install it with one link | [Publish and update](./publish.md)          |
| 4        | Ship the world together with the plugins it needs       | [Collections](./collections.md)             |

If you only make a world and no plugins, skip step 1. Once `pnpm validate:world` passes, you can package it directly.

## Checklist before you publish

- The validation command passes with no errors.
- You installed it from the package, rather than copying the folder straight in.
- Your data is still there after a restart.
- The game still runs after you uninstall.
- The package has a `README.md` that says what it does and which version of Covel it needs.
- The package contains no keys, none of your own saves, no logs, and no paths from your computer.

## If you want to be stricter

The first two steps do not call a real model, and they are enough to find most problems. To check how the real model behaves before you publish, see [Verify with a real model](./real-model.md). If a change affects how players go through the game, play through the whole thing as described in [player-flow acceptance before a release](../internals/e2e-testing.md#player-flow-acceptance-before-a-release).
