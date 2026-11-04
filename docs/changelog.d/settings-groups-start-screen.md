### Changed

- **Settings come in five groups, and each setting has one editor.** General (language, music, reading, appearance), Models, Plugins, Saves & data, and Advanced. Developer mode, debug-trace retention, the chat message window and the world-authoring wait moved to Advanced; the configuration file editor moved there too. Trusted sources stay under Plugins. Capability overrides and the per-step model choices on the start screen now appear only in developer mode. The desktop page no longer has `llm.toml` and `keys.env` editors; it opens the config folder instead.
- **Other screens link to Settings instead of repeating a setting.** The world list asks you to set up an AI model only while none can run. The start screen shows "Using: xxx · Change" instead of a models card. A plugin's model role is changed only on its own settings page and shown as text on the start screen. The music switch is gone from the world detail and showcase pages; Settings and the game menu keep it.
- **The start screen leads with Start.** "Start Game" is the first thing under the world, with the choice of who you play as beside it (each option has a one-line hint, and the choice is hidden when only one is valid). The world document, world state import and export, the plugin list and the checks are folded into "Customize the start". Saved games sit at the bottom, folded.
- **Wording follows one glossary.** "Model roles" are now "AI roles" and "dimensions" are shown as "World state" in Chinese, English and Russian. An empty world list points to installing a world instead of a folder on disk.

### Removed

- **The models card on the start screen.** Settings → Models replaces it.
