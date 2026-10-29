### Fixed

- **A view whose code fails to download once now loads instead of showing the error screen.** When a server restart or a dropped connection cut a code-split chunk mid-download (for example the game view, as a Render free instance wakes), the page showed the "an error occurred while rendering this view" screen and its Retry button could not recover it without a full reload. Lazy-loaded views now retry the download twice (after 0.5 s and 1.5 s); other errors still reach the error screen.
