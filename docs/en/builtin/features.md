# Built-in App Features

This page does not cover plugins. It covers the features the app itself gives players: what each one is, where to find it, and what is worth knowing about it.

## Text and stage views

At the top of the game screen, there are two buttons: "Text" and "Stage". "Text" is a text view you read one page at a time. "Stage" is a full-screen picture with a background and portraits. Both views show the same game, and you can switch between them at any time.

![Text mode](/text-mode.webp)

For details on the stage view, see [Stage and Sound](./stage.md).

## Appearance

Find it under "Settings", in "Appearance". "Style" decides the layout and visual style of the whole interface. It takes effect as soon as you select it. Below it you can fine-tune colors, fonts and more. "Color scheme" lets you choose light or dark.

In "Theme Library" you can "Import theme". Imported themes are saved on this device and appear in the Style list. To make your own theme, see [Themes](../recipes/themes.md).

## AI Create World

On the world selection page, click "AI Create World". Write a "Core Direction", under "Player Experience" choose the gameplay pack the world is made for (the choices are the app's gameplay packs, such as "Traditional Story", "Dialogue Mode" and "Low Cost"), and tick what to generate together: "Main Cast", "World Lorebook", "World Rules", and "Opening Kit". In "Author Notes", you can write what must appear or what to avoid. Click "Start Building". The app then writes the content, checks it for consistency, and packages it as a world package.

![World package builder](/world-package-builder.webp)

Generation uses model calls. If the model produces no output for a long time, you can increase "World authoring: wait for the model (seconds)" in the settings.

Worlds generated in the app can be revised in "Revise this world" on their detail page. Write your request and click "Apply the change". While a revision runs, you can click "Cancel". Your request stays in the box so you can edit it and retry.

When the world dimension editor has unsaved changes, clicking "Cancel" asks whether to discard them. Choose "Keep editing" to retain the drafts; the browser prompts before reloading or closing the page. This also protects incomplete form input and unapplied JSON. For JSON edits, click "Apply definitions" before saving.

## Session-prep screen: choose plugins and gameplay packs

After you choose a world and click "Enter", you reach the session-prep screen ("Session Setup"). Here you decide which plugins are on for this game.

- At the top, you can choose a gameplay pack, such as "Traditional Story", "Dialogue Mode" or "Low Cost". Choosing one turns on all the plugins it includes.
- Below is the plugin list. You can tick plugins one by one. The top shows "x/y plugins selected".
- When a world has its own defaults or recommendations, the list marks them as "World default" or "Recommended by world".
- "Customize plugins and advanced settings" has more detailed options.

After you confirm, click "Start Game". If this is your first time playing, the gameplay pack the world recommends is a good choice. For what each plugin does, see [Built-in Plugins and Features](./index.md).

## Use a different model for a task

Different tasks can use different models. For example, you might use a better model for writing the story, and a cheaper, faster one for organizing world material.

- Global settings: in "Settings", under "LLM" → "Providers & Models", set up your providers and models, and choose a model for each model role. For first-time setup, see [Connect a model](../start/models.md).
- A single task: on the session-prep screen, each plugin task has a "Model" option. You can change it to another model role. The new choice is used from the next turn.

For details on model roles, see [Model roles](../reference/slots.md).

## Retry

Models sometimes fail. The app only redoes the part that failed, so the parts that succeeded are kept.

- When one task fails, click "Retry this task" to retry only that task.
- When several tasks fail, click "Retry failed tasks". The story text and other completed results are kept.
- Before retrying, you can click "Change model / parameters" to switch to another model, or lower the output limit. The retry uses the current settings.
- If the start-of-game setup fails, click "Retry setup". It only runs the steps that did not finish.
- If the app stops unexpectedly, unfinished tasks stop, and the progress that was saved is kept. A new attempt starts only when you click "Retry unfinished turn".

## Debug page

In the "More" menu on the game screen, there is "Debug Traces". You can also open `/debug` directly. It lists the run record of each task in each turn, along with model calls and retries. Use it to find the cause when something goes wrong. In the same menu, you can switch between "Detailed view" and "Raw view" to see something closer to the raw data.

## Interface language and translated worlds

In "Settings", "Interface Language" decides the language of buttons and labels. Currently there are Simplified Chinese, English and Русский. Languages marked "experimental" only have the interface translated. The instructions the model reads are still in English, so the quality of the story depends on the model.

The interface language and the story language are different things. The content language of a game is set when it starts, and it must be a language the world already has. If a world only has another language, you are asked "Continue with a <language> world?" before entering. You can also click "Translate to <language>" on the world's detail page to add a language version of the world.

Translation is done by the model you configured, so it uses model calls. Check the names of people and places, and the tone, yourself afterwards, since machine translation can get them wrong. For the language rules, see [Internationalization](../reference/i18n.md).

## Install plugins and worlds

In "Settings", "Install & manage" can install plugin packages, world packages and collection packages from GitHub or from ZIP files, and can uninstall them. After an install, you need to restart the backend for it to take effect. Code in third-party plugins only runs after you authorize it in a session. For detailed steps, see [Install plugins and worlds](../start/packages.md).

## Export and import settings

Under "Data" in "Settings". "Export settings" saves the settings on this device as a JSON file, which you can use as a backup or move to another device. The default file does not include API keys. Tick "Include API keys (sensitive)" to include them. Keep this file safe.

When importing, choose the file first. In the preview, tick the items you want to apply, then click "Apply". The selected items overwrite the current values, and the other settings stay the same.

## Next

- [Stage and Sound](./stage.md)
- [Built-in Plugins and Features](./index.md)
