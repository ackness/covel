### Breaking

- **Session events use one current payload shape.** `ui.rendered` always includes the committed `render` and `block`; `narrative.delta`, `narrative.completed`, and `runtime.started` require `kind`. Custom event producers must send these fields. Clients no longer rebuild UI blocks or infer a kind from runtime labels. See the session protocol reference.
