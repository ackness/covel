# LLM Surface Guidelines For Extensions

This reference describes how an extension should teach both:

- the host agent/Codex
- the runtime model

without bypassing current host contracts.

## 1. Agent-Facing Guidance

Use these surfaces for Codex/agent understanding:

- `SKILL.md`
  Explain package purpose, workflow, boundaries, and when to use each surface.
- `manifest.description`
  One-line summary for discovery.
- `command.help`
  Human-readable usage/examples.
- `command.autocomplete`
  Positional hints and flags that make slash workflows discoverable.

Keep `SKILL.md` concise. Put deep reference material in package-local docs only if it is repeatedly needed.

## 2. Runtime Model-Facing Guidance

Use structured host-owned surfaces:

- `contextProviders`
  Inject facts, style, memory, or state fragments.
- capability descriptions and schemas
  Define deterministic tool/workflow contracts.
- block schemas
  Tell the model what structured UI outputs are allowed.
- task bindings / presets
  Decide which model route handles the task.

Current output model should be taught in this order:

- now:
  - `message`
  - `block`
  - `artifact`
- later:
  - `state_patch`
  - `workflow_event`

Do not rely on the model reading the package `SKILL.md` directly during normal runtime.

## 3. Package-Specific Model Behavior

If a package needs distinct LLM behavior:

- prefer task separation, such as:
  - `story.narration`
  - `story.choice-generation`
  - `story.image-prompt`
- bind those tasks through preset/profile policy
- use `modelPolicy.preferredTier` only as a host hint

Do not hardcode vendor/model names inside package business logic.

## 4. Frontend/Backend Operation

Teach the model and agent to use package FE/BE surfaces in this order:

1. backend command/capability decides what happened
2. backend emits block/artifact/message
3. frontend renders block/artifact via trusted host surfaces
4. user interaction returns as `submit_block_response`
5. package-owned resume handler continues the flow

This is the primary mental model that extension docs should reinforce.

Do not teach packages to:

- invent a custom transport
- assume local-first execution
- assume they can mount arbitrary frontend code
- assume they own provider routing or retry strategy
