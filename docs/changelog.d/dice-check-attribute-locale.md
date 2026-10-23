### Fixed

- **Dice checks without a usable ability no longer show an attribute label in the instruction language.** When no ranged ability is available, the check rules use modifier 0 and omit the optional `attribute` field from the receipt. `COVEL_INSTRUCTION_LOCALE` therefore cannot insert an English "None" into a Chinese session or a Chinese label into another language. See [RPG mechanics](../builtin/rpg.md) and [plugin language rules](../reference/plugins.md).
