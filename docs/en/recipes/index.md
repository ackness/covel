# Common Tasks

After you have read [Your first world](../worlds/first-world.md) and [Your first plugin](../plugins/first-plugin.md), you probably have a specific goal in mind. Each page in this chapter solves one task.

## World authors

| Task                                                                      | What you get                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Pre-place quests, items, and affinity in a world](./starting-content.md) | Start the game with quests, carried items, and relationships already in place |
| [Point buy and dice checks at the start](./point-buy.md)                  | Assign attribute points at the start, and let dice decide risky actions       |
| [Character portraits](../worlds/portraits.md)                             | Each character has its own portrait                                           |
| [Scene pictures](../worlds/scenes.md)                                     | Each place has a day background and a night background                        |
| [Collections](../ship/collections.md)                                     | Install a world and the plugins it needs in one step                          |

## Plugin authors

| Task                                              | What you get                                             |
| ------------------------------------------------- | -------------------------------------------------------- |
| [Add a UI to a plugin](../plugins/ui.md)          | Side panels, and forms and choices inside the story text |
| [A plugin with code](../plugins/local-code.md)    | The model can call tools that you write                  |
| [Verify with a real model](../ship/real-model.md) | Check how a real model behaves before you publish        |

## Everyone

| Task                                                       | What you get                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [Make and share a theme](./themes.md)                      | Your own interface colors and styles, which you can export and share |
| [Install plugins and world packages](../start/packages.md) | Install worlds and plugins that other people made                    |

## Learn from the built-in implementations

For some needs, the fastest route is to modify a built-in plugin:

| Need                                                   | Reference                                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Replace the narrator                                   | [`narrator`](../../../plugins/narrator/README.md) and [`chat-mode-narrator`](../../../plugins/chat-mode-narrator/README.md) |
| Hidden story that appears only when conditions are met | [`story-events`](../../../plugins/story-events/README.md)                                                                   |
| Connect an image or voice service                      | [Image generation](../reference/image-generation.md) and [Media storage](../reference/media-store.md)                       |
| Add day and night and the passage of time to a world   | [World time](../reference/world-time.md)                                                                                    |
| Add a language to a plugin or world                    | [Multiple languages](../reference/i18n.md)                                                                                  |

Don't see the task you want here? Suggest it on [GitHub](https://github.com/ackness/covel/issues).
