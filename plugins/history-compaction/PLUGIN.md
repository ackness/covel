---
id: history-compaction
kind: core
displayName: History Compaction
description: Maintains bounded rolling summaries of older conversation history.
provides:
  - contract: history.compact@1
    default: true
entry: ./server/index.js
contributes:
  extensions:
    - point: history.compact@1
      id: rolling-summary
---

# History Compaction

Protects recent turns and merges older dialogue with the previous rolling summary. The kernel controls budget admission and atomically persists validated compaction results. Source messages remain stored.

## Quality Characteristics

**Information Loss**: The compaction process is lossy by design. It preserves narrative flow and key facts but discards conversational nuance, exact phrasing, and minor details. Attribute values may be approximated (e.g., "Stealth 20" could become "high stealth" or a slightly different number in the summary).

**Not a Retrieval System**: Compacted history is a continuous summary, not a searchable index. For fact retrieval or precise recall, pair it with a dedicated memory plugin (e.g., `memory`).

**Truncation Under Budget**: When the compaction result exceeds the allocated token budget, it is truncated from the end. This may drop recent sections of the summary. The kernel's budget allocation must account for this behavior.

**Best Practices**:

- Combine with a dedicated memory system for precise fact retention
- Configure adequate token budget to minimize truncation risk
- Use a dedicated memory plugin (e.g., `memory`) for structured data that must survive intact
