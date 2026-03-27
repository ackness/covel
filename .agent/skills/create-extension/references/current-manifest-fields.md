# Current Package Manifest v1 Cheat Sheet

Top-level fields commonly used:

- `schemaVersion`
- `name`
- `version`
- `description`
- `kind`
- `defaultEnabled`
- `scopes`
- `permissions`
- `dependencies`
- `modelPolicy`
- `contributes`
- `settings`
- `state`

## `modelPolicy`

Current host shape:

```json
{
  "preferredTier": "small"
}
```

Use it to express package preference, not to hardcode provider or model identity.

## `contributes`

- `contextProviders`
- `commands`
- `hooks`
- `capabilities`
- `blockTypes`
- `renderers`
- `artifactTypes`

## Entry Shapes

### Context Provider

```json
{
  "id": "worldbook-context",
  "entry": "server/context.ts",
  "reads": ["world", "session", "memory"],
  "writes": []
}
```

### Command

```json
{
  "name": "world-seeds",
  "description": "Inspect staged world seed content.",
  "argsSchema": "schemas/commands/world-seeds.args.json",
  "entry": "server/commands/world-seeds.ts",
  "resume": false
}
```

### Hook

```json
{
  "id": "story-image.after-narration",
  "phase": "afterNarration",
  "trigger": {
    "type": "event",
    "event": "narration.completed"
  },
  "entry": "server/hooks/after-narration.ts"
}
```

### Capability

```json
{
  "id": "story-image.generate",
  "type": "workflow",
  "entry": "server/capabilities/generate.ts",
  "inputSchema": "schemas/capabilities/generate.input.json",
  "outputSchema": "schemas/capabilities/generate.output.json"
}
```

### Block Type

```json
{
  "type": "choice_set",
  "dataSchema": "schemas/blocks/choice-set.data.json",
  "responseSchema": "schemas/blocks/choice-set.response.json",
  "resume": {
    "handler": "director-choices.resume-choice"
  },
  "ui": {
    "component": "schema",
    "renderer": "choice-set"
  }
}
```

### Renderer

```json
{
  "name": "choice-set",
  "entry": "client/renderers/choice-set.tsx"
}
```

Only add this when host-known rendering is insufficient.

### Artifact Type

```json
{
  "type": "scene-image",
  "kind": "image",
  "mediaType": "image/png"
}
```

### Setting

```json
{
  "key": "storyImage.autoGenerate",
  "type": "boolean",
  "default": false,
  "scope": "world"
}
```

### State

```json
{
  "collection": "choice_state",
  "scope": "session",
  "schema": "schemas/state/choice-state.json"
}
```

## Permission Guidance

Common permissions in current host docs:

- `read:world`
- `read:session`
- `read:memory`
- `read:archive`
- `read:packages`
- `read:preset`
- `emit:block`
- `invoke:model`

Only request the minimal set the package actually needs.
