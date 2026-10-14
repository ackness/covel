### Fixed

- **World setup reuses authored schemas consistently and silently.** Guard output now matches the published contract, accepts small authored schemas, and only adopts missing dimensions when setup reruns.
- **Random world time follows the host random stream.** Fixed seeds reproduce time steps across different session and turn IDs; repeated calls in one turn reuse the settled result.
