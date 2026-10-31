### Changed

- **Starting a session is independent of changes to other worlds and unrelated plugins.** Creation validates this world’s content and files and the registered identities and authorization of the plan’s plugins, receivers and contract providers. Stale rejections include a stable reason. Timestamp refreshes, JSON object key order and changes to the package-edited marker also leave unchanged world content valid. See [world data receiver rules](../reference/world-data.md#data-receivers).
