# Stage and Sound

This page covers stage mode, a full-screen view like a visual novel. It also covers the two built-in plugins that make the view more complete: Scene Stage and Soundtrack.

| Plugin                      | In short                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Scene Stage (`scene-stage`) | Records the current scene, day or night, and the characters on stage, for the stage to use |
| Soundtrack (`soundtrack`)   | Plays the world's background music to match the scene and mood                             |

## Stage mode

Stage mode turns a game into a full-screen visual novel picture.

![Stage mode](/stage-mode.webp)

You will see:

- Background: a picture of the current scene. It can differ between day and night.
- Portraits: the characters on stage stand in front of the background. The character who is speaking is highlighted.
- Dialogue box: the story text is shown one paragraph at a time, with the speaker's name beside it (taken from the story's segments, shown once the story is complete). Click the screen to go to the next paragraph.
- Choices: when you need to decide, possible responses appear below the dialogue box. You can also click "✎ Write your own…" and write your own words.

The name of the current scene is shown on the screen. A row of small buttons lets you open "History" (to look back at the conversation), turn "Auto-play" on or off, or enter "Fullscreen stage". To go back to the text view, click "Exit stage".

### How to switch

At the top of the game screen there are two buttons side by side: "Text" and "Stage". Click "Stage" to enter stage mode, and "Text" to go back to the text view. Switching does not affect your save, and you can switch back and forth at any time.

### What the world needs to provide

Stage mode needs no extra setup on its own, but how complete the picture is depends on what the world includes:

| What the world includes | Effect on the stage                                                                                   | How to do it                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Scene pictures          | When the story moves to a place, the background changes to that place's picture                       | [Add scene pictures to a world](../worlds/scenes.md)  |
| Character portraits     | Characters stand in front of the scene                                                                | [Add portraits to characters](../worlds/portraits.md) |
| Neither                 | The stage still works, but the background falls back to the world's cover, and there are no portraits | -                                                     |

The scene picture and on-stage character data come from Scene Stage below. Enable it on the session-prep screen for scene backdrops and on-stage characters. You can still read the story in stage mode without it.

## Scene Stage (`scene-stage`)

Lets the stage know where things are, whether it is day or night, and who is present.

### What you will see

- The background and portraits on the stage come from this plugin. Speaker name tags come from the narrator's story segments and do not need it.
- On the right there is a "Scene" tab. It contains a read-only "Scene" panel (the scene name, day or night, and where the background comes from) and a "Cast" panel. The "Cast" panel also says why each character was chosen, for example "Mentioned", "In scene", "Profile", or "Recent".
- If the place cannot be found in the world's scene pictures, the background shows "No backdrop", and the stage uses the world's cover instead.
- A location change clears an existing stage-direction cast before applying the new entries. Without new entries, portraits from the old location disappear. Day/night changes at the same location keep the actors. Worlds without direction state still use cast selection.

### When it is on

Optional. The built-in "Dialogue Mode" gameplay pack includes it. The "Campus Romance · Visual Novel" pack for Harukaze Academy also includes it.

### What you can change

| Name            | What it does                                                                                                       | Default |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ------- |
| Active speakers | How many NPCs to recommend as the main participants in this turn, from 1 to 4. This does not cap the story’s cast. | 2       |

World authors can set a different default for this world in `pluginSettings.scene-stage.activeSpeakerCount` in `world.yaml`.

### What world authors can preset

| Content                 | File                         | Notes                                                                 |
| ----------------------- | ---------------------------- | --------------------------------------------------------------------- |
| Scene background images | `media/scenes/`              | Put only image files here. The index is created on import.            |
| Scene registry          | `media/scenes.registry.json` | Do not write this by hand. A script generates it. See the link below. |

For how to do it, see [Add scene pictures to a world](../worlds/scenes.md). For field details, see [World data](../reference/world-data.md).

### Notes

- At the start, if the story has not said where it is, the stage uses the first scene in the scene registry. So the screen is never blank at the beginning.
- Places are matched by name. See [The name decides whether the background changes](../worlds/scenes.md#the-name-decides-whether-the-background-changes) for naming advice and examples. A location name that is too short cannot select one background when several scenes contain it. Use the full name.

## Soundtrack (`soundtrack`)

Plays the world's own background music. When the story moves to a new place, or the mood clearly changes (for example, entering a battle), the music changes to match.

### What you will see

There is no panel. A speaker button at the top of the game screen lets you "Mute the music" or "Play the music". Music fades in and out when it changes.

### When it is on

Optional. No built-in gameplay pack selects it. You have to tick it yourself in the plugin list on the session-prep screen. None of the built-in worlds includes music yet, so it only makes sound if you install or make a world that has music.

### What you can change

The plugin itself has no settings. The music on/off switch and the volume are in the app's settings:

| Name             | What it does                                   | Notes                                                                      |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Background music | Whether background music plays during the game | It is the same switch as the speaker button at the top of the game screen. |
| Music volume     | 0 to 100                                       | When narration voice plays, the music is lowered automatically.            |

### What world authors can preset

| Content     | File               | Notes                                                                          |
| ----------- | ------------------ | ------------------------------------------------------------------------------ |
| Music files | `media/music/`     | `.mp3` or `.wav`. Put only the files here.                                     |
| Track list  | `media/music.yaml` | For each track, the file, the scene, the mood, and which one is the theme song |

In the track list, you name the moods yourself. Use the top-level `moods` to say when each mood applies. The story only uses the moods you list. Here is a minimal example:

```yaml
schemaVersion: 1
registryId: music-registry
tracks:
  - id: tavern
    file: tavern.mp3
    scenes: [歪角鹿酒馆]
  - id: theme
    file: theme.mp3
    theme: true
```

Tracks near the top of the list take priority. The first matching track is chosen in this order:

1. A track that matches the current mood and also belongs to the current scene.
2. A track that matches the current mood, with no scene limit.
3. The track that belongs to the current scene.
4. A theme track marked `theme: true`.
5. If nothing fits, it stays silent.

A mood written as `silence` stops the music. If no track has a mood, the music follows only the scene and the theme song. For the full format, see the [plugin README](../../../plugins/soundtrack/README.md).

### Works with

Scene changes come from Scene Stage. If Scene Stage is not on, the music can only be chosen by mood and the theme song.

## Next

- [Built-in app features](./features.md): besides the text and stage views, what else the app offers.
- [Add scene pictures to a world](../worlds/scenes.md)
- [Add portraits to characters](../worlds/portraits.md)
