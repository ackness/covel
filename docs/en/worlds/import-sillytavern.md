# Import SillyTavern content

Turn existing SillyTavern character cards or lorebooks into an ordinary Covel world package. V2, V3 and flat legacy JSON cards are supported, along with PNG cards containing `chara` / `ccv3` text chunks. Import a lorebook on its own or combine it with several character cards.

This feature is for desktop and self-hosted Web. It writes to the server's user worlds directory. It cannot import a world into a browser-private BrowserVault.

## Import in the app

1. Open **Settings → Install & manage** and find **Import SillyTavern content**.
2. Select character cards and lorebook files. The selected files become one world.
3. Choose the content language and optionally enter a world name. The language defaults to your interface language; card text is neither detected nor translated.
4. Click **Preview**. Review the world ID, character count, lore entry count, cover and report grouped by severity. Preview writes no files and creates no world record.
5. After reviewing the report, click **Import**. The world appears immediately, without a restart. Changing files, language or name requires a new preview.

See the [install API](../reference/api.md#plugin-and-world-install-install) for count and size limits and the response shape.

## How character cards map

<!-- prettier-ignore -->
| Source field | Imported result |
| --- | --- |
| `name`, V3 `nickname` | NPC name and alias; the first card's name is also the default world name |
| `description`, `personality` | Character description and `blueprint.persona.summary`; the first card's description also supplies the world summary; long text is shortened and reported |
| `scenario` | Scenario in the world text, grouped by character for multiple cards |
| `first_mes` | Character blueprint opening; the first card also supplies Opening in the world text |
| `mes_example` | Dialogue examples parsed from `<START>` blocks and player / character lines |
| `system_prompt`, `post_history_instructions` | Narration notes in the world text, with an explicit warning |
| `creator_notes` | Omitted entirely and reported; never written to the package or summary, so they cannot enter model prompts |
| `tags`, `creator` | Combined world tags and the first non-empty author |
| `character_book` | Added to the lorebook |
| First PNG card image | Cover after text and other metadata are stripped; not a character portrait; each later PNG image is reported as omitted by source |

If there is no scenario, opening or narration note, the first card's description supplies Premise. A lorebook-only world uses the world name as a neutral Premise. Entry content stays solely in the lorebook, entering prompts according to enabled status and keyword rules; it is never copied into world text that is read every turn. Import fails when no usable text remains.

## How lorebooks map

| Source field                  | Imported result                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `keys` / `key`                | Deduplicated literal keywords; regex keys are removed and reported                |
| `content`, `name` / `comment` | Lore text and title; empty content is skipped                                     |
| `constant`                    | Constant or keyword-triggered; selective entries without literal keys are skipped |
| `enabled` / `disable`         | Whether the entry is enabled; `disable: true` wins                                |
| `insertion_order` / `order`   | Insertion order                                                                   |
| `position`                    | Reduced to before or after plugins; lost positioning semantics are reported       |
| `scanDepth`                   | History depth clamped to Covel's supported range                                  |

Alternate greetings, group-only greetings, multilingual creator notes, secondary keywords, probability, sticky entries, cooldowns, groups, recursion, vector search and other advanced matching settings are omitted. Covel has no corresponding opening selector or matching mechanism. Entry IDs are regenerated. Extensions, scripts, regex scripts, executable macros and other unmappable fields are listed in the report. The original JSON is never stored in the package.

## Report and safety

The report distinguishes information, warnings and errors, with source files, fields and counts. Known codes have translated labels; unknown codes show the English server explanation. Extensions are listed by key name only, without displaying or running script values.

Import performs data conversion only. SillyTavern extensions, scripts, regex expressions and macros are never executed. Only fixed substitutions such as the character and player names are applied; other macros are removed and reported. HTML tags, active elements and dangerous link targets are cleaned; ordinary safe links may remain. PNG parsing reads bounded plain text chunks and does not decompress compressed text chunks.

Cleaning cannot decide whether prompt text is trustworthy. Scenarios, lore and narration notes are still read by models, at the same trust level as other third-party world packages. Pay particular attention to the warning that card instructions were included as plain narration notes.

## Keep editing and add languages

The result contains `world.yaml`, `WORLD.md`, and, when applicable, `characters/characters.json`, `data/lorebook.yaml` and `media/gallery/cover.png`. It selects the dialogue pack by default; you can change the selection before starting. It creates no portraits, `presence.json` or separate media-store records.

Continue editing in world details or edit these ordinary files in your user worlds directory. See [world data](../reference/world-data.md) for character and lore formats. There is one language edition; the manifest's `defaultLocale` is the language you selected.

To add English or another language, switch your interface to that language and choose “Translate to 〈language〉” in world details, then review the translation. The existing translation flow adds editions without another import. See [localization](../reference/i18n.md).

## Redistributable samples

These original test samples were written for this repository and can be used to try the importer:

- [V2 character card](../../../tests/fixtures/st-import/sample-card-v2.json)
- [V3 character card](../../../tests/fixtures/st-import/sample-card-v3.json)
- [Standalone lorebook](../../../tests/fixtures/st-import/sample-world-info.json)

## Troubleshooting

| Symptom                                                           | What to do                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| PNG has no usable card text chunk, or has compressed text only    | Export JSON from the original tool and import that                         |
| Character name is empty after cleaning, or no usable text remains | Add a name and content, then preview again                                 |
| File or generated lorebook exceeds a limit                        | Split or shorten the content; check the report and API limits              |
| World ID conflicts                                                | Retry; choose a different world name if conflicts persist                  |
| Warnings or ID change between preview and import                  | Another import may have taken the ID; the import response is authoritative |
