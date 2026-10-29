### Added

- **Agent loops can repair invalid output with tools off.** The repair request includes validation errors and asks for a complete replacement answer. Step events mark it with `repair: true` and an `output-repair` note.
- **Correction budgets are configurable in `agent.loop.corrections`.** Tool use, response review, loop perturbation and output repair have independent budgets, defaulting to 1, 2, 1 and 1 respectively.

### Changed

- **An agent runtime whose output fails its schema or whose story text is empty gets one repair request before failing.** Repair requires completed tool work and at least three seconds remaining; completing-tool output is validated directly. A replacement answer retains its stop reason and adds `repaired: true`; output that remains invalid fails with `invalid-output`.

### Fixed

- **Output repair preserves thinking-provider continuation data.** Replayed drafts retain the accepted response's reasoning and provider continuation, including finalizer drafts and repeated repair attempts. Tool-call drafts reuse their canonical transcript turn with its tool calls, so native continuations remain valid after a hook ends the loop.
- **Output repair keeps tools off after request hooks.** `PreLLMCall` cannot restore tools during repair.
