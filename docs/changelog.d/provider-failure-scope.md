### Changed

- **Provider account failures explain which model uses share the problem.** Setup, recovery and failed-task notices name the provider and list the session’s active model uses routed to it. The failed provider and model survive reloads; authentication recovery opens provider settings to fix the shared key.
- **Starting without a model key offers a choice.** Session prep names the providers and text uses missing credentials, with actions to add a key or start anyway. Built-in remote providers without a key fail before any network request and are not retried; local and custom endpoints can still work without keys. Missing-key notices distinguish an absent key from an invalid one.
