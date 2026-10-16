# Narrative and Memory

This page explains how the story is written, how you get suggestions after it, and how a long game remembers what happened earlier. "Narrator" and "Dialogue Narrator" are two ways to tell the story that replace each other, so a game uses only one of them.

| Plugin                                    | In short                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Narrator (`narrator`)                     | Tells the story like a novel, one scene per turn.                                                                              |
| Dialogue Narrator (`chat-mode-narrator`)  | Tells the story mostly through character dialogue, for chat-style play.                                                        |
| Action Suggestions (`guide`)              | After each part of the story, recaps what came before, points out the choice in front of you, and offers actions to pick from. |
| Reply Variants (`branch-reply`)           | Writes several other versions of the same turn, and you pick one.                                                              |
| Story Memory (`memory`)                   | Remembers the plot, the scene, character relationships and the player character's state.                                       |
| History Compaction (`history-compaction`) | Shortens very old messages into a summary, so a long game stays within the model's length limit.                               |

## Pick a way to tell the story

`narrator` and `chat-mode-narrator` do the same job: they write the next part of the story based on your action. They cannot be on at the same time. Pick one.

|                | Narrator (`narrator`)                                         | Dialogue Narrator (`chat-mode-narrator`)                                 |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Reads like     | A 200 to 400 character novel passage                          | A conversation, with characters taking turns to speak                    |
| Good for       | Exploration, investigation, adventure, and other long stories | Romance, everyday life, roleplay, and other play that relies on chatting |
| Matching packs | Traditional Story, Low Cost                                   | Dialogue Mode                                                            |
| Needs          | Nothing else                                                  | Scene Stage (`scene-stage`) and Action Suggestions (`guide`)             |

How to choose:

- If you are not sure, use the gameplay pack the world recommends. The world has already chosen one for you.
- If you want to read a story and value description and reasoning, choose "Narrator".
- If you want characters to talk back and forth with you, and you want to see portraits and a stage, choose "Dialogue Narrator".
- If you want to keep model costs down, choose the "Low Cost" pack. It uses "Narrator" and has no extra model calls for things like action suggestions.

> [!WARNING]
> "Dialogue Narrator" depends on "Scene Stage" and "Action Suggestions". It cannot be turned on if either one is missing. "Narrator" has no such requirement.

## Narrator (`narrator`)

Continues the story from your latest action, describing the scene, how characters react, and the results. It writes one passage per turn, and usually ends on a cliffhanger, a question, or an action that is not finished yet. It writes only story text and does not list options. Action choices are handled by "Action Suggestions".

### What you will see

The story text in the chat area.

### When it is on

It is a core plugin (`kind: core`) and the default way to tell the story. The "Traditional Story" and "Low Cost" gameplay packs both include it.

### What you can change

| Setting          | What it does                                                                                                                                                     | Default             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Narrative person | How narration refers to your character: first person (I), second person (you), or third person (the character's name). Dialogue keeps each speaker's own person. | Second person (you) |

A world can set a default for this setting in `pluginSettings`. Your own setting takes priority.

### Notes

Once the story is written, its narration is checked for the correct person. If it is wrong, the model is asked to rewrite it, up to two extra model calls. You only see the text after it passes the check.

## Dialogue Narrator (`chat-mode-narrator`)

Makes the story feel more like a conversation between characters. Each paragraph shows who is speaking, and the highlight on stage follows the speaker.

### What you will see

The story text in the chat area, split by speaker. Portraits and the stage are shown by "Scene Stage". See [Stage](./stage.md).

### When it is on

Optional. The "Dialogue Mode" gameplay pack includes it.

### What you can change

| Setting          | What it does                                                                           | Default             |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------- |
| Narrative person | Same as "Narrator".                                                                    | Second person (you) |
| Dialogue ratio   | Roughly how much of a reply is character dialogue and inner reactions. Range 30 to 90. | 70                  |
| Reply length     | Short, medium or long.                                                                 | Medium              |

A world can preset these settings. For example, "Harukaze Academy · Spring Mint" (遥风学园·春日薄荷) sets the dialogue ratio to 80 and the reply length to short.

### Works with

- It needs "Scene Stage" to supply the characters on stage, and "Action Suggestions" to supply scene hints.
- It cannot be on at the same time as "Narrator".

## Action Suggestions (`guide`)

After each part of the story, recaps the relevant earlier events, explains the choice you are facing now, and then gives 3 to 4 short actions you can use right away.

### What you will see

- Traditional Story: below the story in the chat area, a suggestion block appears with a recap, the current choice, and a few action buttons.
- Dialogue Mode: the actions also appear in the choice bar on the stage.

When you tap an action, it is only filled into the input box at the bottom. It is not sent. You can edit it, or write your own action and send it yourself.

### When it is on

Optional. The "Traditional Story" and "Dialogue Mode" gameplay packs include it. "Low Cost" does not. It adds one model call per turn, using the model of the `plugin` role. See [Connect a model](../start/models.md).

### Works with

It needs a storytelling plugin ("Narrator" or "Dialogue Narrator").

## Reply Variants (`branch-reply`)

The same turn can be generated again, giving you several different versions. You pick the one you want. The version you pick replaces the original wording of that turn in the rest of the story.

### What you will see

A "Reply candidates" block appears below the story in the chat area. Each candidate is an option. Click it to use it. For the current turn you can also press the number keys. Under each candidate there are two smaller actions, "Draft" and "Send". The block also has "Regenerate", which asks for a new batch of versions.

Regenerating uses the model of the `fast` role. If no model is available, the original text is kept. No versions are made up.

### When it is on

Optional. The "Dialogue Mode" gameplay pack includes it. Worlds such as "Emberback Relay" and "Lantern Barrow: First Expedition" list it as recommended or required.

### Works with

It does not depend on a particular storytelling plugin. You can use it with either "Narrator" or "Dialogue Narrator".

## Story Memory (`memory`)

After each turn, it records the key points of the story automatically, and includes them when the story is written later. In a long game, it helps the model remember clues, promises and relationships between characters.

### What you will see

The "Core Memory" panel on the right lists what is remembered, in blocks. There are four blocks by default: Story State, Character Relationships, Current Scene, and Player Profile. At the start of a game the panel is empty. It fills in after the first turn ends.

Each block is rewritten in full every turn, so it stores the "current state". Separately, up to 3 new facts can be recorded each turn, and old facts are never edited. When your later input mentions something related, the related old facts are brought back.

### When it is on

It is a core plugin (`kind: core`). The "Traditional Story", "Dialogue Mode" and "Low Cost" gameplay packs all recommend it.

Updating the memory takes one more model call. It runs in the background, so you do not have to wait for it. It uses the model of the `memory` role. See [Connect a model](../start/models.md). If an update fails, the story of that turn is still saved, and the update is tried again on the next turn.

> [!NOTE]
> Memory is summarized by a model. It may miss details that were mentioned only once, or misunderstand them. For state that must be exact, such as attributes and items, check their own panels. Do not rely only on memory.

### What world authors can preset

A world can replace the four default blocks with its own memory blocks, so memory records clues, relics, countdowns and similar things that suit its genre. The file is `data/memory-blocks.json`. Write one object: `id` is `world`, and the `blocks` list has, for each item, `label`, `displayName` and `extractionHint`. `icon` and `maxChars` are optional. Do not add a block for data that another dimension or plugin already records.

"Mistport: The Riftide Chronicle" (雾港・裂潮纪) includes such a file. For field details, see [World data reference](../reference/world-data.md).

## History Compaction (`history-compaction`)

When a story gets longer, the early conversation can fill the length the model can read. This plugin condenses the older conversation into summaries in sections, and keeps the most recent turns exactly as they are.

### What you will see

Usually nothing. The original messages are still kept in the save. The model just sees the summary instead. A summary the model stopped before finishing counts as a failure, and a half summary never replaces the original conversation. If compaction fails three times in a row, the app tells you that the story's memory could not be condensed.

### When it is on

It is a core plugin (`kind: core`). No gameplay pack needs to list it. Compaction uses the model of the `fast` role. It has no settings you can change.

> [!NOTE]
> Summaries lose exact wording and small details, and numbers may be turned into rough figures. For details you need to remember exactly, use "Story Memory".

## Next

- Stage, portraits and scenes: [Stage](./stage.md)
- Change the model for a task: [Connect a model](../start/models.md)
- Preset data for a world: [Starting content](../recipes/starting-content.md)
- Back to the overview: [Built-in Plugins and Features](./index.md)
