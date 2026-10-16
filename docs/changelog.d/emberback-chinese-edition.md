### Changed

- **The Chinese edition of Emberback reads as natural Chinese.** Every text in `worlds/emberback` was translated again for meaning rather than word for word, and checked line by line against the English: 37 meaning errors are fixed (among them the starting location, the convoy states and the signal-log values the model must write). The five player attributes have plainer Chinese labels, and four names that were wrong in meaning are renamed: the Switchyard, the Long Blackout, Mirror Farm (no longer sharing a name with the Solar Fields) and June Okafor. Sessions created before this change keep the text they were created with.
- **Emberback's Chinese names are plainer and used one way throughout.** The Chinese edition renames the place, the Duskline, the Crownfire and its front, the Nightglass observatory, the Nightward Shelf and the Condenser Yard; Dr. Mina Park, Priya Nair and Tomas Reed's title; the linekeeper, the crawler and Echo Reading with its two top ranks; the three history events; and the storm reader, trade chits, cryo-pack and field radio. Only the Chinese files change; the English edition, ids and keys are untouched. Sessions created before this change keep the names they were created with.

### Fixed

- **Two Emberback world rules fire in Chinese sessions.** `emberback-future-echoes` and `emberback-signal-evidence` now have Chinese trigger words; before, they only matched English words in the player's message.
- **Emberback no longer contradicts itself about Mile Seventeen.** The repeater sits beneath the arch everywhere, and every line repeats the warning as "do not let the convoy reach Mile Seventeen".
