# Lantern Barrow: The First Delve

Greyreed sits at the edge of Greyreed Marsh: thirty-odd households, a mill, a tavern, a small chapel. The hill north of the village is Lantern Barrow. For a hundred years the old lantern on its summit has burned every night, handed down from one lampkeeper to the next. Every child here grows up knowing two rules: stay off the hill after dark, and if the lantern goes out, tell an adult right away.

Three days ago, the lantern went out.

That night Lampkeeper Ysolde carried an oil lamp through the bronze tomb doors, which stood open halfway up the hill, and never came back out. The next day the sheep outside the village started going missing one by one, and the fog over the marsh turned cold enough to sting. The miller's daughter says she hears singing underground at night — someone singing her dead grandfather's name. Reeve Aldous Penn has posted a notice at the Crooked Antler: thirty silver coins to go down into the tomb and bring the lampkeeper back.

Take the job at the tavern, put a party together, spend your starting points, roll the dice, go down. You've just arrived in Greyreed, an adventurer nobody here knows yet.

## Greyreed

- **The Crooked Antler**: the village's only tavern, and its inn. Mirelle Voss keeps the place; she has a long memory and a closed mouth. Most of what gets said in Greyreed passes her bar first. A night's bed and board runs two silver coins.
- **The Reeve's House**: two floors of stone, the lord's crest over the door. The reeve wants this settled before the lord's letter arrives.
- **The Lampkeeper's Cottage**: a stone house at the foot of the barrow, Ysolde's home for forty years. Lamp oil inside, and dozens of old logbooks. The door has never had a lock. The newest logbook stops dead three days before the lantern went out.
- **The Mill**: the miller's daughter was the first to hear the singing.
- **The Dawn Chapel**: a small chapel to the light. Empty for a long time, until Sister Wren moved in yesterday.

## People

- **Brannoc Hale**: a retired soldier of fifty who has spent three days drinking alone in the corner of the tavern. He says he's only passing through, but his eyes keep drifting toward the barrow. Twenty years ago he went into this tomb with a small band. He was the only one who came out.
- **Sister Wren**: nineteen, an acolyte of the Order of the Dawn Lantern, sent to inspect the lantern. She arrived three days late. She can mend wounds and read the old lantern inscriptions, and she carries a question about her faith that she hasn't asked anyone.
- **Mirelle Voss**: owner of the Crooked Antler. Shrewd, warm, and she only hands over the truth once she's decided you're worth it.
- **Reeve Aldous Penn**: Greyreed's reeve. Respectable, anxious, and vague about the days just before the lampkeeper disappeared.
- **Lampkeeper Ysolde**: in her seventies, forty years tending the lantern. She went into the tomb alone the night it went out.
- **Corvin Ashe**: a young scholar from the capital, here a month, asking questions about the lantern wherever he went. He gave up his room the day before the lantern went out. Nobody saw him leave the village.

Brannoc and Wren can be recruited. They have their own judgment, their own opinions, their own secrets. When things get dangerous they act on their own, and they remember how you treated them.

## The Lantern Barrow

The tomb is larger inside than the hill that holds it. Only the way in is known:

- **The Bronze Doors**: open since the night the lantern went out. The seal was pushed from the inside.
- **The Hall of Lamps**: the lampkeeper used to say that wall lamps line both sides of the first passage. Light them again and the barrow sleeps deeper. On the night Ysolde went in, she appears to have trimmed and doused select sconces from the outside in, like a deliberate breadcrumb trail back to daylight.

An ossuary, flooded burial chambers, a gallery where the dead sing, a throne at the heart of the hill — the rest is for your party to find. The Delve Map on the right keeps track of each room.

The barrow sleeps, but lightly. Fighting, forcing doors, raising your voice, lighting a fire in the Choir Gallery, or resting too long down there all bring it closer to waking. Relighting the wall lamps, or passing quietly, settles it back. When the Barrow Alarm reaches 6, the Barrow King opens his eyes.

## Rules at a Glance

- **Point-buy**: Might, Agility, Endurance, Wits, Insight, and Presence each start at 1. Distribute 6 more points among them, to a maximum of 4 in any one attribute.
- **Checks**: start one from the Attribute checks panel on the right, or use `/roll` at any time. The panel and the dice-pool receipt show the modifier, difficulty, and result.
- **Hit points**: at 0, you collapse. You don't die immediately, and companions can drag you back.
- **Supplies and gear bonuses**: A torch burns for about one phase of the day. Without light, you can't see where you're going or spot traps. Your Bag tracks rations, healing draughts, silver coins, and tools; carrying a torch, rope, shortsword, or chalk helps the checks they fit, while failed rolls can cost torches or chalk or fill failure clocks like Barrow Chill and Unquiet Dead.
- **Panels**: quests, Bag, companion affinity, failure clocks, Delve Map, Barrow Alarm, The Barrow Lantern, and Renown all update as the story goes.

<!-- narrator-only -->

## Notes for the Game Master and World Extensions

Run it the way a good GM would: concrete scenes, brisk pace, and the choice handed back to the player at the end of every turn. Call for a check only when the outcome is uncertain and failure costs something, and name the attribute and difficulty first. Failure should push the story forward at a price in time, torches, chalk, hit points, position, or trust — never leave the party stuck. Keep the danger real without gore. Laughter in the tavern, singing in the tomb.

Keep world mechanics cleanly partitioned across the active generic plugins:
- **Checks, gear, and failure costs**: Risky rolls run through `dice-check` and `tabletop-rules` with carried-item bonuses from `inventory` and companion cooperation from `affinity`; when a check fails, write the settled `check-clocks` (`barrow-chill`, `unquiet-dead`) or `check-consequences` item loss directly into the scene.
- **World dimensions**: Advance `delveMap` strictly along adjacent exits, reckon `barrowAlarm` from tomb time phases plus noise, update `lantern` from confirmed discoveries, and adjust `renown` only after word reaches Greyreed. Quest deadlines settle automatically via `core-quest`.
- **Deep lore**: Details on Old Greyreed, the Dawn Lantern Order, Penn's accounts, and individual barrow chambers live in `lorebook`; uncover them layer by layer rather than dumping everything early.

There is no fixed ending. Putting the Lantern Heart back, striking a bargain with the Barrow King, destroying him for good, or some other thing the player comes up with should all work — and all cost.

<!-- /narrator-only -->

## Opening

A wet late-autumn chill carries the smell of peat marsh under the threshold as you push open the heavy oak door of the Crooked Antler. Muddy boot prints trail across the pine floorboards. Sparks crackle up the hearth, catching the fresh black ink on the reeve's notice pinned above the bar: thirty silver coins for Lampkeeper Ysolde.

At the darkest corner table, fifty-year-old veteran Brannoc Hale wipes an old blade down with an oiled rag; by the rain-streaked window, young Sister Wren presses her thumb across an open codex of lantern inscriptions, road-mud still speckling her cuffs. Out north in the rain, Lantern Barrow rises black against the mist, three nights dark on its crown. Mirelle Voss slides a steaming mug of ale toward you, her eyes flicking from the hilt at your belt to your pack:

"Stranger—you here about the notice too?"
