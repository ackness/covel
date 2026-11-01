### Added

- **Stage departures fade locally.** Previously displayed actors keep their loaded images throughout a brief exit without flashing a loading placeholder while the current cast changes immediately. Explicit transitions, reduced motion and session resets retain their meaning.
- **Story templates can display and enlarge their speaker’s portrait.** `CharacterAvatar` uses only the host-projected speaker visual and explicit current session, with no extra character or session lookup.

### Changed

- **Scene Stage uses compact dialogue avatars with local previews.** Missing portraits or unresolved speakers leave the nameplate and story readable. Cast state still updates immediately; no development data needs recreating.
