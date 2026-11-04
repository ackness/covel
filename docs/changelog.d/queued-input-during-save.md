### Fixed

- **A choice or message sent while the previous turn is still saving is no longer lost.** The story arrives and input re-enables before the browser finishes saving that turn. A click in that window was silently rejected, so the turn never started and the same choices stayed on screen. Input sent then now waits for the save and runs right after it; a second submission while it waits is still refused. If the session pauses or ends before the save finishes, or the send fails, the text goes back to the input box.
