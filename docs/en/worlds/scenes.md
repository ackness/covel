# Add scene pictures to a world

This page explains how to add background pictures to the places in a world: a classroom, a harbor, the common room of an inn, and so on. Each place gets a daytime picture, and you can also add a nighttime picture. It is written for world authors. You do not need to program, but you do need to run commands and edit JSON files.

When you finish, a player in stage view sees the background change to the picture of the place where the story is. Each picture is generated only once. Later, every new game uses the saved pictures.

The steps are almost the same as [Add portraits to characters](./portraits.md): write a manifest, preview, make the pictures, and generate the matching manifest. It helps to read that page first.

## Before you start

- You have [run Covel from source](../start/run-from-source.md) and run `pnpm install --frozen-lockfile`.
- Put the world folder in the repository's `worlds/` directory, for example `worlds/tidelamp/`. The scripts look only in this place.
- To make pictures with the script, you need an image model and the command-line tool `cwebp`. Setting up both is the same as for portraits. See [Add portraits to characters](./portraits.md#before-you-start).

Run the commands below from the root of the repository.

> [!CAUTION]
> Making pictures calls a paid image service. Commands with `--dry-run` or `--scaffold` make no network calls and cost nothing. Install `cwebp` before you generate for real; without it the script stops with an error before it requests a picture, and nothing is charged.

## The whole process

| Step | What you do                                                         | What you get                                             |
| ---- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| 1    | Write the scene manifest, or let the script draft one               | `media/scenes.json`                                      |
| 2    | Improve the picture description for each scene                      | An updated `media/scenes.json`                           |
| 3    | Preview the prompts, without making pictures                        | The prompts on screen                                    |
| 4    | Generate the pictures, or add pictures you made yourself            | `<id>-day.webp` and `<id>-night.webp` in `media/scenes/` |
| 5    | Generate the manifest that says which picture goes with which scene | `media/scenes.registry.json`                             |
| 6    | Validate, then start a game and check the result                    | The background in stage view                             |

## 1. Get a scene manifest

**If the world describes geography in `data/dimensions.yaml`** (`regions` under `geography`), the script can draft a manifest from the regions:

```bash
pnpm exec tsx scripts/generate-scenes.mjs tidelamp --scaffold
```

```text
scaffolded 3 new scene draft(s) into worlds/tidelamp/media/scenes.json (3 total). Rename ids + polish subjects, then re-run with --dry-run.
```

To also draft an entry for each landmark in each region, add `--landmarks`. You can run this command again. Entries that already exist are not overwritten. Only the new places are added.

**If the world has no geography**, this command reports `no regions found …`. Write the manifest by hand instead. Create `worlds/tidelamp/media/scenes.json`:

```json
{
  "world": "tidelamp",
  "style": {
    "prefix": "Background art for a coastal mystery game, painterly semi-realistic scenery, cold sea-fog palette, no people, no characters, ",
    "suffix": ", clean wide establishing composition, calm lower third left clear for dialogue, consistent art style, no readable lettering",
    "negative": "people, character, figure, silhouette, text, caption, watermark, logo, frame",
    "nightSuffix": ", at night, deep blue ambient light, warm lamps and lit windows, readable midtones"
  },
  "defaults": { "size": "1536x1024", "quality": "medium" },
  "scenes": [
    {
      "id": "quay-inn",
      "name": "码头客栈",
      "locationRef": "码头客栈/客栈大堂",
      "subject": "Interior of a small harbour inn common room, low beams, a long scrubbed table, a brass storm lantern on the counter, fishing nets drying by a salt-stained window, grey daylight",
      "subjectNight": ""
    }
  ]
}
```

## 2. Improve the manifest

| Field                          | Meaning                                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `style.prefix`, `style.suffix` | The art style shared by all scenes. Use the same style words as the portrait manifest for this world, so the backgrounds and the characters look like one set                                   |
| `style.negative`               | What to leave out of every scene. A scene picture should have no people in it                                                                                                                   |
| `style.nightSuffix`            | Added only to the end of the night prompt. It describes the light at night                                                                                                                      |
| `defaults.size`                | The picture size. The default is `1536x1024` (landscape)                                                                                                                                        |
| `defaults.quality`             | The picture quality. The default is `medium`                                                                                                                                                    |
| `scenes[].id`                  | The name of the scene, and the start of the file name. The pictures are called `<id>-day.webp` and `<id>-night.webp`. Use a short, meaningful English name, for example `library` or `quay-inn` |
| `scenes[].name`                | The name shown for the scene                                                                                                                                                                    |
| `scenes[].locationRef`         | The places this background matches, separated by `/`. Write the scene’s own place first, followed by sub-locations within it                                                                    |
| `scenes[].subject`             | The description of the daytime picture                                                                                                                                                          |
| `scenes[].subjectNight`        | A description used only for the night picture. If it is empty, the night picture uses `subject`                                                                                                 |

Three things in a drafted manifest must be changed:

- The `id` is a placeholder such as `scene-01` or `scene-02`. Change it to a meaningful short English name.
- The `subject` was copied as it is from the geography description. Rewrite it as an English picture description: specific objects, light, mood, and composition. Do not include people.
- The `style` is a general anime background style. Change it to suit your world.

The prompt for each picture is built like this:

- Day picture: `style.prefix` + `subject` + `style.suffix`
- Night picture: `style.prefix` + `subjectNight` (or `subject` if there is none) + `style.suffix` + `style.nightSuffix`

So do not write day-only phrases such as "afternoon sunshine" in `style.prefix`. They would conflict with the night picture. Write the daytime light in `subject`, and the night light in `nightSuffix` (or `subjectNight`).

### The name decides whether the background changes

The game does not know what your picture shows. It matches the place name reported in the story against the names of the scenes. Use `name` and the first part of `locationRef` for the scene’s own place, and the later parts for sub-locations within it. The world data reference gives the full [matching order](../reference/world-data.md#scene-backgrounds).

For example, the classroom in Harukaze Academy has a sub-location called "Window Seat". "Library window seat" still uses the library background because the location explicitly names the library. "Window seat" alone, or "Class 2-B window seat", uses the classroom background.

So two rules of thumb:

- Write the names the way the story will use them, in line with `WORLD.md` and the geography setting.
- Do not let two scenes share the same short word. If one scene has "east corridor" and another has "west corridor", "corridor" alone matches neither one.

When no scene matches, the stage uses the world’s cover. This is not an error.

## 3. Preview, without making pictures

```bash
pnpm exec tsx scripts/generate-scenes.mjs tidelamp --dry-run
```

Using the built-in 遥风学园 (Harukaze Academy) as an example, add `--limit 1` to look only at the first scene:

```bash
pnpm exec tsx scripts/generate-scenes.mjs haruka-academy --limit 1 --dry-run
```

```text
world=haruka-academy slot=gpt-image-2 size=1536x1024 quality=medium — 2 scene task(s) queued (dry-run, no network calls):

  classroom-2b [day] → classroom-2b-day.webp
    Visual novel background art, clean anime scenery style, …, no people, no characters, Interior of a bright Japanese high school classroom, …

    Avoid: people, character, figure, silhouette, text, caption, watermark, logo, frame, signature

  classroom-2b [night] → classroom-2b-night.webp
    Visual novel background art, clean anime scenery style, …, The approved seaside classroom after sunset, viewed from the same window-side aisle, …
```

One scene has two tasks, one for the day picture and one for the night picture. A scene whose `subject` is still empty is skipped, and you are told to write it first.

## 4. Get the pictures

### Generate them with the script

```bash
pnpm exec tsx scripts/generate-scenes.mjs tidelamp --slot image
```

After `--slot`, write the name of the model role you gave the image model in `llm.toml`. If you leave it out, the script looks for a role named `gpt-image-2`. Where the script reads model settings and keys from, and how to run it when the config is in the repository root, are the same as for the portrait script. See [Where the script reads model settings and keys](./portraits.md#生成方式框架统一-image-wire).

The pictures are saved in `worlds/tidelamp/media/scenes/`. The script prints one line for each finished picture, and ends with `done: N ok, M failed`. Pictures that already exist are skipped. So if some failed, run the same command again as it is. It fills in only what is missing.

| Option                    | What it does                                                                     |
| ------------------------- | -------------------------------------------------------------------------------- |
| `--scaffold`              | Draft the manifest from the regions in `data/dimensions.yaml`. Makes no pictures |
| `--landmarks`             | Use with `--scaffold` to also draft each region's landmarks as scenes            |
| `--dry-run`               | Print the prompts only. No network calls, no pictures                            |
| `--slot <name>`           | Which model role in `llm.toml` to use. The default is `gpt-image-2`              |
| `--only <id>[,<id>]`      | Process only these scenes                                                        |
| `--variant day\|night`    | Make only the day picture or only the night picture. If omitted, both are made   |
| `--limit <N>`             | Process only the first N scenes in the manifest                                  |
| `--force`                 | Overwrite pictures that already exist                                            |
| `--size <width x height>` | Change the size for this run. Takes priority over `defaults.size`                |
| `--quality <quality>`     | Change the quality for this run. Takes priority over `defaults.quality`          |
| `--concurrency <N>`       | How many pictures to make at the same time. The default is 5                     |

Three common redo cases:

- Change one scene: edit its `subject`, then run `--only quay-inn --force`.
- Redo only the night picture: `--only quay-inn --variant night --force`.
- Change the whole set's style: edit `style`, then run with `--force`.

> [!WARNING]
> The script makes the day and night pictures separately from their text. The two pictures do not refer to each other. So the camera angle, the doors and windows, and the furniture in the night picture may not line up with the day picture. The background will "jump" when you switch between day and night. Writing "the same room" in the prompt does not fix this.
>
> To keep the day and night pictures at the same camera position, first finalize the day picture. Then use a tool that can edit an image from a reference image. Use the day picture as the reference and change only the light, to make the night picture. Then add it as described below. The built-in 遥风学园 was made this way. The night picture the script makes directly is good enough for a rough draft of a new place.

### Add pictures you made yourself

1. Put the PNG in `worlds/tidelamp/media/scenes/`, named `<id>-day.png` or `<id>-night.png`.
2. Convert it to WebP:

   ```bash
   node scripts/encode-world-webp.mjs worlds/tidelamp/media/scenes/quay-inn-night.png
   ```

3. Delete the PNG. If you keep it, both files are imported when a game starts.

## 5. Generate the manifest that links scenes to pictures

```bash
node scripts/emit-scenes.mjs tidelamp
```

```text
wrote worlds/tidelamp/media/scenes.registry.json with 1 scene(s)
```

`scenes.registry.json` records which file is the day picture and which is the night picture for each scene. It identifies each picture by a checksum calculated from the picture's content. So do not write it by hand, and do not edit it by hand.

Rules when a picture is missing:

| Case                             | Result                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The scene has no day picture     | The whole scene is left out of the manifest. At the end, the script lists the skipped scenes. The day picture is required |
| The scene has only a day picture | It is written to the manifest with an empty night picture. In the game, the day picture still shows at night              |

> [!IMPORTANT]
> If any picture in `media/scenes/` changes, run this command again. Otherwise the manifest keeps the checksum of the old picture, and the game cannot find the picture.

## 6. Make the world use these pictures

**You register nothing.** `media/scenes/` and `media/scenes.registry.json` are fixed locations, the scripts above write only there, and they are imported automatically. The same holds when the world has `data/world.data.yaml`: that file writes only what differs from the conventions. For the format, and how to write the sources for other locations, see the [world data reference](../reference/world-data.md#scene-backgrounds).

> [!NOTE]
> When the world's `data/world.data.yaml` names `media/scenes.registry.json`, the file must exist, or the world fails validation. If the pictures are not ready yet, run `node scripts/emit-scenes.mjs <world ID>` once first. It writes an empty placeholder manifest with no scenes. After you make the pictures, run it again.

**This session needs the plugin that manages scenes turned on.** The built-in one is "Scene Stage" (`scene-stage`). It is included in the "Dialogue Mode" (`dialogue-mode`) pack, and not in "Traditional Story". Change `pluginPolicy.preset` in `world.yaml` to `dialogue-mode`, or add `scene-stage` to `pluginPolicy.plus`. Or, on the session-prep screen, open "Customize plugins and advanced settings" and select it there.

To have players start in stage view as soon as they enter the game, add this line to `world.yaml`:

```yaml
defaultViewMode: stage
```

For the full description of the fields, see [Scene Backgrounds in the world data reference](../reference/world-data.md#scene-backgrounds).

## 7. Validate, then check in the game

```bash
pnpm validate:world worlds/tidelamp
```

Start Covel (`pnpm dev`), and **start a new game**:

| What you do                                                                       | What you should see                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Look at the world in the world list and the world details, before starting a game | The world's pictures include these scene pictures                                          |
| After the game starts, switch to the "Stage" view                                 | When the story's place has a picture, the background is that picture                       |
| Move the story to another place that has a picture                                | The background changes with it. The "Scene" tab in the right panel shows the current scene |
| Move the story into the night                                                     | Scenes with a night picture switch to it. Scenes without one keep the day picture          |

Pictures are imported when a game is created, so after you change a picture, start a new game to see it.

When you check the pictures themselves, look at these things: whether the area where the dialogue box sits and the area where characters stand are clean, whether the night picture is bright enough to read, whether the camera position matches between day and night, and whether the picture has any garbled signs or text.

## Not every world suits "day and night"

The day and night pictures are designed for worlds with a daily cycle, such as a school. Other worlds may not fit well if you copy this approach:

- A harbor that is always foggy is better described by high tide and low tide.
- A planet with one side always facing the sun has no day and night. Storms and power outages are better states to show.

The manifest has only two slots, "day" and "night" for now. A world like this can make only the day picture. For the choices made for each built-in world, see [World art direction](./art-direction.md).

## When it does not work as expected

| Symptom                                                                               | Cause and fix                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scaffold` reports `no regions found in …/dimensions.yaml`                          | The world's geography has no list of regions. Write `media/scenes.json` by hand                                                                                                                |
| A preview says `… has an empty subject — polish scenes.json first, skip`              | This scene's `subject` is empty. Write it, then run again                                                                                                                                      |
| `--variant must be one of: day\|night`                                                | After `--variant`, you can write only `day` or `night`                                                                                                                                         |
| `Slot [covel.gpt-image-2] missing in …`, `No API key. …`, `cwebp is not installed; …` | A problem with the model config, the key, or `cwebp`. For how to fix these, see [the troubleshooting table on the portrait page](./portraits.md#when-it-does-not-work-as-expected)             |
| `emit-scenes` says `missing day image, skipped: …`                                    | These scenes have no day picture, so they were not written to the manifest. Add `<id>-day.webp` and run again                                                                                  |
| Validation cannot find `media/scenes.registry.json`                                   | `data/world.data.yaml` lists it, but the file does not exist yet. Run `emit-scenes` once                                                                                                       |
| The background never changes in the game                                              | Check these in order: whether it is a new game; whether "Scene Stage" is turned on; whether you are in the "Stage" view; whether the place name in the story matches a scene name (see step 2) |
| The background changes to the wrong place                                             | Two scenes contain each other's names, or they share a short word. Make `locationRef` more specific                                                                                            |
| The picture jumps when switching between day and night                                | The day and night pictures were made separately, so the camera positions differ. Redo the night picture using the day picture as the reference                                                 |
| You changed a picture, but the game shows the old one or none                         | You did not run `emit-scenes` again, or you are looking at a game that was started before the change                                                                                           |

## Next steps

- **Add portraits to characters.** See [Add portraits to characters](./portraits.md).
- **Set the art direction for the whole world, and learn what to check before release.** See [World art direction](./art-direction.md).
- **Add background music to the world.** See [Background Music in the world data reference](../reference/world-data.md#background-music).
