# Your first game session

This page guides you through choosing a world, writing your first action, and checking that you can continue the saved game. When you finish, you will have a game that you can pick up again after restarting the app.

## Before you start

- You have [installed](./install.md) Covel and opened it.
- You have [connected a model](./models.md), and the connection test passed.

## 1. Choose a world

On the world selection screen, pick one of the built-in worlds. To read the background first, open the world details. When you are ready, click "Enter" on the card.

For a first game, these are good choices:

- To read a story: **Mistport Chronicles** (雾港・裂潮纪).
- To see portraits and scenes: **Haruka Academy · Spring Mint** (遥风学园).
- To use dice, quests, and an inventory: **Emberback Relay** or **Lantern Barrow: First Expedition**.

> [!NOTE]
> The interface language and the language of the world content are two different things. The interface language only decides the buttons and labels. The content language of a game is set when the game is created, and it must be a language version that the world already has.

## 2. Check the play style on the session-prep screen

After you click "Enter", you reach the session-prep screen. Here you decide which plugins this game uses.

- The world suggests a **gameplay pack**, which is a set of plugins that work well together. On your first game, keep the suggestion.
- To add or remove plugins, or to give a task a different model role, expand "Customize plugins and advanced settings".
- If the page says a setting is missing, fill it in as the page asks. Usually, a model role has no model yet.

When you are ready, click "Start Game".

## 3. Finish the opening

Before the story starts, the game may ask you to do a few things:

- **Create a character**: fill in or choose the name, background, and attributes of the main character.
- **Opening choices**: some worlds let you assign attribute points, or choose a starting situation.

These forms come from the plugins, and they differ from world to world. When you finish, the first passage of the story appears.

## 4. Write your action

Type what the main character does in the input box, and then send it. You can also click one of the action suggestions below the story text.

During one turn, you will see these things, in order:

1. The story text appears one character at a time.
2. After the story text is finished, the state keeps updating. Panels such as quests, inventory, and affinity change accordingly.
3. "Turn complete" appears. At this point, all the results of this turn have been saved.

> [!TIP]
> Wait for "Turn complete" before you send the next message. The story text being finished does not mean the turn is over. Plugins are still updating the state after it.

To change how the story is displayed, switch between the parsed view and the stage view.

## 5. Check that you can continue

Close Covel and open it again, then go back to the same world. The world lists your saved games. Click "Continue your last adventure" to pick up from the last turn.

If previous sessions fail to load, the preparation page shows an error and a Retry button. Click Retry to load your saves again; you can still start a new game.

You have now been through a whole game: choose a world, check the play style, finish the opening, act, save, and continue.

## When a turn does not finish as expected

| What you see                                             | What happened                                                                        | What to do                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| "Stopped; turn not committed"                            | You stopped the generation part way, and this turn was not saved                     | Retry with the same input                                                                                              |
| The story text appeared, but some updates failed         | The story was generated, but the state update of one or more plugins did not succeed | Click "Retry failed tasks". Only the failed items are retried. The story text and the other completed results are kept |
| No story text at all                                     | The model did not respond, or the model does not support tool calls                  | Go back to [connect a model](./models.md) and test again. Or switch to a model that supports tool calls                |
| You cannot click "Start Game" on the session-prep screen | Some settings are still missing                                                      | Fill in each missing item as the page indicates                                                                        |

To see what each plugin did in a turn, expand the turn's execution details. The more complete trace is on the Debugger page.

## Next steps

- To get more worlds and play styles: [install plugins and world packages](./packages.md)
- To learn where saves are kept and how to back them up: [data, backup, and upgrade](./data-and-upgrade.md)
- To make your own world: [your first world](../worlds/first-world.md)
