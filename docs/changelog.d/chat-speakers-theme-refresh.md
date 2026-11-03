### Fixed

- **Chat names dialogue speakers without a segment template.** A dialogue or action segment that names a speaker shows the name above its text when no plugin template matches it, or when its template fails to render. Stories with only narration still read as plain prose.
- **A session theme no longer flickers off after each turn.** Reloading the session's plugin list with the same plugins used to drop and refetch the theme, and every theme refresh re-rendered every story on the page. The theme now reloads only when the active plugins or language change, and story text re-renders only when the session's theme is switched on or off.
