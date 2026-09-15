---
name: npc-graph/rag-retriever
description:
  zh: 当你提到某个人时，帮助故事想起相关人物和关系。
  en: When you mention someone, helps the story remember related people and relationships.
---

NPC graph retriever (function runtime).

Runs automatically before every narrative turn:

1. Reads this session's NPC nodes, edges, and adjacency indices (`plugin_data[nodes/edges/index]`)
2. Matches node names and aliases against `playerMessage` first. If none match, uses the optional same-turn `currentCast` input from `scene-cast` to match complete names or aliases unambiguously. Character IDs and graph node IDs are separate; without a cast provider, retrieval still works from player input.
3. Performs a 2-hop BFS from the matched nodes using only the latest currently valid relationships. Expired relationships cannot expand the recalled subgraph.
4. Keeps only edges whose valid interval is still open (`invalidAt === undefined`); superseded versions stay in storage for provenance but never reach the prompt
5. Sorts by recency (`validAt` descending) and absolute strength, taking the top 20
6. Emits `npcContext` (a markdown list) for `narrator` to consume via `input.inject`

When the graph is empty or no node was hit, the output is `npcContext: ""` and the `narrator` prompt naturally skips the corresponding section.

This runtime calls neither an LLM nor an embedding service. Current cast supplies retrieval candidates without claiming pronoun resolution. Input binding establishes same-turn execution order and data delivery; it does not read another plugin's uncommitted storage.
