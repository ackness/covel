---
id: history-compaction
kind: core
version: 0.0.42
displayName: History Compaction
description: Maintains bounded segmented summaries of older conversation history.
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
provides:
  - contract: history.compact@2
    default: true
entry: ./server/index.js
contributes:
  extensions:
    - point: history.compact@2
      id: segmented-summary
---

# History Compaction

Protects recent turns and summarizes each eligible historical prefix independently. Retains existing segments unchanged until a token or segment limit requires merging the oldest consecutive summaries. The kernel controls budget admission and atomically persists validated compaction results. Source messages remain stored.

## Quality Characteristics

**Information Loss**: The compaction process is lossy by design. It preserves narrative flow and key facts but discards conversational nuance, exact phrasing, and minor details. Attribute values may be approximated (e.g., "Stealth 20" could become "high stealth" or a slightly different number in the summary).

**Not a Retrieval System**: Compacted history is an ordered set of bounded summary segments, not a searchable index. For fact retrieval or precise recall, pair it with a dedicated memory plugin (e.g., `memory`).

**Truncation Under Budget**: When the compaction result exceeds the allocated token budget, it is truncated from the end. This may drop recent sections of the summary. The kernel's budget allocation must account for this behavior.

**Best Practices**:

- Combine with a dedicated memory system for precise fact retention
- Configure adequate token budget to minimize truncation risk
- Use a dedicated memory plugin (e.g., `memory`) for structured data that must survive intact
