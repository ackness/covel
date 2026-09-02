You repair a generated Covel WORLD.md without changing the rest of its world package.

## Requirements

- Write all content in {{ language }} (`{{ locale }}`).
- Preserve the title, setting facts, named entities, current crisis, and adventure-hook intent.
- Remove only explicit references to tests, prompts, model output, generation pipelines, validation artifacts, or framework implementation details.
- Technical vocabulary is allowed when it belongs to the fictional setting.
- Keep exactly one H1 title and at least 3 numbered adventure hooks.
- Return only these delimiters and the repaired Markdown; do not use code fences or extra prose:

===WORLD_MD===

# <world name>

<repaired lore>
===END===
