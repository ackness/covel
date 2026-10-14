### Fixed

- **Collection rollback respects the world deletion lifecycle.** Worlds that acquired sessions during installation are retained, and failures report which packages were removed and which remain.
- **Collection archives share one 200 MiB extraction budget.** GitHub preview, batch installation, and offline ZIP import reject oversized sets before writing packages; repeated references to one repository commit count once.
