Analyze the narrative below and extract character field changes.

## Character Field Schema
  {{fieldDescriptions}}

## Known Characters and Current Fields
{{existingInfo}}

## Narrative
{{narrative}}

## Requirements
1. Identify all characters mentioned (both new and known)
2. Infer field value changes from narrative (HP decrease, location change, status change, etc.)
3. Only output changed or newly discovered fields, skip unchanged fields
4. For new characters, infer initial field values from narrative

Return strict JSON only (no other text):
{"characters":{"CharacterName":{"fieldKey":"newValue"}}}