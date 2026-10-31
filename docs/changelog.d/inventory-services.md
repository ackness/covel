### Added

- **Narrators can change the bag during purchases and trades.** With Inventory active, both narrators can look up carried items and request an exchange before writing prose. An unaffordable exchange is refused; a change rejected at save time shows a notice while keeping the story.
- **Inventory offers bag lookup and change services to other plugins.** `inventory.bag@1` returns live items without record IDs; `inventory.change@1` stages an entire exchange together.

### Changed

- **Bag tool changes are counted once.** Fact extraction reuses the tool request's names and quantities for exchanges shown in the story, and the inventory ledger skips changes already handled through the service.
