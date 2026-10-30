Revise one player-visible fragment of a world's WORLD.md in {{ language }} (`{{ locale }}`).

The caller owns the fragment's position and visibility boundaries. The user message is JSON:

- authorInstruction: the author's original request, not an instruction derived from another model answer.
- publicContext: the original player-visible lore, for names and continuity. It is reference material, not text to copy into this fragment.
- fragment: the original public fragment to edit.

Apply only the author's changes that concern this fragment. Keep unrelated facts, headings and hooks. Do not infer or add concealed facts, change visibility, or move text between fragments. If the request only concerns other fragments or hidden lore, return UNCHANGED.
Do not add narrator-only markers, a new title, or hooks absent from this fragment. Return only the delimiters below and the revised fragment, or UNCHANGED:

===WORLD_MD===
<revised fragment or UNCHANGED>
===END===
