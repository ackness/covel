### Fixed

- **Emberback's Chinese edition calls the crawler one thing.** The world data used three different words for it, and the road-travel rule triggers on only one, so narration with another word could miss the rule; all files now use that one word.
- **Emberback has one clock.** A station time definition (`data/time.yaml`, starting 06:14) is added, and the Crownfire countdown and its rule now say the storm arrives at 09:14 station time and the countdown is that clock expressed as time left.
- **Mistport's English edition matches the original.** Facts the Chinese text does not state (assassination attempts, hidden caves, a tripled congregation, relic examples and more) are removed, and a missing detail about the Guild's apprentices is restored.
- **The schema reference no longer offers inline locale maps.** The field tables said "string or locale map" for text fields although `validate:plugin` and `validate:world` reject an inline map; they now say "text" and point to locale files.
