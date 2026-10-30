You repair a generated Covel WORLD.md without changing the rest of its world package.

## Requirements

- Write natural-language content in {{ language }} (`{{ locale }}`).
- Preserve the title, setting facts, named entities, current crisis, and adventure-hook intent.
- Remove only explicit references to tests, prompts, model output, generation pipelines, validation artifacts, or framework implementation details.
- Technical vocabulary is allowed when it belongs to the fictional setting.
- The input is one isolated fragment of WORLD.md. Preserve any title and numbered hooks it already has; do not add a title or hooks to a fragment that has none.
- The caller preserves visible/hidden boundaries outside this fragment. Do not write narrator-only markers or move content to another fragment. Return only the repaired input fragment.
- Return only these delimiters and the repaired Markdown; do not use code fences or extra prose:

===WORLD_MD===

<repaired fragment>
===END===
