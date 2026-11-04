### Changed

- **The session header has one menu.** It now reads: back, world, turn and status chips, a Read / Stage switch (with a ▾ for plugin pages), "Menu" and "Side panel". The palette, speaker, gear and "⋯" buttons are gone. "Menu" holds this game's settings, start over and export, background music (marked as applying to all games), this game's theme with "Restore default appearance", and Settings. [Session screen](../en/reference/ui-panels.md) lists the three sections.
- **"Studio Config" became "This game's settings".** The left rail is replaced by a drawer from the menu with saves (world, turn and date, never a raw ID), the plugins in this game, and a collapsed "Advanced" block (Speaking rules, Characters speaking at once, Helper calls, Auto-advance turns). A plugin's model is shown as text with a "Go to settings" link instead of a select. "Start over" (formerly "Prepare") asks first and keeps the save.
- **One set of words for the views and questions.** "Text" and "Parsed view" are now Read; "Stage view" is Stage; "Suspended executions" is "Waiting for you" (a chip in the header, with "Send answer" instead of "Resume"). Russian uses Чтение / Сцена. The glossary lists the terms.
- **Developer view is now Developer mode.** The setting `ui.developerView` keeps its key and your saved value, moves to Settings → Advanced, and gates everything meant for authors: the top-bar "Debugger" entry, the detailed and raw views, debug traces, the Database tab, the side panel's storage line, raw IDs, plugin step counts and the raw-data box in the "Waiting for you" dialog. A session on a detailed or raw view returns to Read when the mode is off.
- **The top bar is navigation only.** It shows World, Games (renamed from Session, and only while a game is open), Settings and the bell. Debugger appears in developer mode only.

### Removed

- **The top bar's Plugins and Images entries, theme toggle and language select.** Settings has a plugins pane, dark mode and the interface language; Images stays a side-panel tab and the `?panel=images` link still opens it. The per-plugin model select in the game is gone; change models in Settings.
- **The "§ SESSION CANVAS" decoration on the opening card.**
